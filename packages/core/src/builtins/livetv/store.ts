import { promisify } from 'node:util';
import { zstdCompress, zstdDecompress } from 'node:zlib';
import { Cache } from '../../utils/cache.js';
import {
  createLogger,
  DistributedLock,
  requestLockType,
} from '../../utils/index.js';

const logger = createLogger('livetv');
const compress = promisify(zstdCompress);
const decompress = promisify(zstdDecompress);

/** JSON, compressed, as base64. */
export const pack = async (value: unknown) =>
  (await compress(Buffer.from(JSON.stringify(value)))).toString('base64');

export const unpack = async <T>(data: string) =>
  JSON.parse(
    (await decompress(Buffer.from(data, 'base64'))).toString('utf8')
  ) as T;

/**
 * Values in memory, backed by the database, which other replicas and restarts
 * read. Not Redis: values run to megabytes, and Redis holds them in memory.
 * The database keeps JSON as it is, so values go in compressed.
 */
export class TieredStore<V, S> {
  private readonly memory: Cache<string, V>;
  /** The value compressed, and when it expires, which saves the store a lookup. */
  private readonly shared: Cache<string, { until: number; data: string }>;
  private readonly revalidating = new Set<string>();
  private readonly loading = new Map<string, Promise<V>>();
  private readonly encode: (value: V) => S;
  private readonly decode: (stored: S) => V;
  private readonly staleTtl: number;

  constructor(
    private readonly name: string,
    opts: {
      memoryBytes: () => number;
      sizeOf: (value: V) => number;
      encode: (value: V) => S;
      decode: (stored: S) => V;
      /** Seconds left below which a value is refreshed. */
      staleTtl?: number;
    }
  ) {
    this.memory = Cache.getInstance<string, V>(
      name,
      opts.memoryBytes,
      'memory',
      { clone: false, sizeOf: opts.sizeOf }
    );
    this.shared = Cache.getInstance<string, { until: number; data: string }>(
      `${name}-shared`,
      undefined,
      'sql'
    );
    this.encode = opts.encode;
    this.decode = opts.decode;
    this.staleTtl = opts.staleTtl ?? 0;
  }

  /** The value and its seconds left, read into memory from the shared store if need be. */
  async peek(key: string): Promise<[V, number] | undefined> {
    const value = await this.memory.get(key);
    if (value !== undefined) return [value, await this.memory.getTTL(key)];
    return this.peekShared(key);
  }

  /** The shared store's value, kept in memory, if more than `beyond` seconds are left. */
  private async peekShared(
    key: string,
    beyond = 0
  ): Promise<[V, number] | undefined> {
    const stored = await this.shared.get(key).catch(() => undefined);
    const left = stored ? Math.floor((stored.until - Date.now()) / 1000) : 0;
    if (!stored || !(left > beyond)) return undefined;
    let decoded: V;
    try {
      decoded = this.decode(await unpack<S>(stored.data));
    } catch {
      // Written by another version, so fetched again as if missing.
      return undefined;
    }
    await this.memory.set(key, decoded, left);
    return [decoded, left];
  }

  /** Written through, as replicas waiting on {@link load} read it next. */
  async set(key: string, value: V, ttl: number): Promise<void> {
    await this.memory.set(key, value, ttl);
    try {
      await this.shared.set(
        key,
        {
          until: Date.now() + ttl * 1000,
          data: await pack(this.encode(value)),
        },
        ttl,
        true
      );
    } catch (err) {
      logger.warn(
        { cache: this.name, err: err instanceof Error ? err.message : err },
        'live TV shared store write failed'
      );
    }
  }

  /** Kept in this replica only, as for a failure's marker. */
  async setLocal(key: string, value: V, ttl: number): Promise<void> {
    await this.memory.set(key, value, ttl);
  }

  /**
   * Fetches into both tiers once across replicas: the others wait for the
   * lock and read what it stored, or fetch for themselves if it couldn't be.
   * A replica's stale copy gives way to another's newer one.
   */
  load(
    key: string,
    fetch: () => Promise<{ value: V; ttl: number }>,
    lockMs: number
  ): Promise<V> {
    let pending = this.loading.get(key);
    if (!pending) {
      pending = (async () => {
        /** Got under the lock; the shared store may not keep it. */
        const got: { value?: V } = {};
        await DistributedLock.getInstance().withLock(
          `${this.name}:${key}`,
          async () => {
            // Fresh, so another replica refreshed it.
            const newer = await this.peekShared(key, this.staleTtl);
            if (newer) {
              got.value = newer[0];
              return true;
            }
            const { value, ttl } = await fetch();
            await this.set(key, value, ttl);
            got.value = value;
            return true;
          },
          { timeout: lockMs, ttl: lockMs, type: requestLockType() }
        );
        if (got.value !== undefined) return got.value;
        // Not memory, which may hold a stale copy.
        const stored = (await this.peekShared(key))?.[0];
        if (stored !== undefined) return stored;
        const { value, ttl } = await fetch();
        await this.setLocal(key, value, ttl);
        return value;
      })().finally(() => this.loading.delete(key));
      this.loading.set(key, pending);
    }
    return pending;
  }

  /** The value, refreshed behind it once fewer than `staleTtl` seconds are left. */
  async getOrRevalidate(
    key: string,
    load: () => Promise<V>,
    refresh: () => Promise<void>
  ): Promise<V> {
    const found = await this.peek(key);
    if (!found) return load();
    const [value, left] = found;
    if (left < this.staleTtl && !this.revalidating.has(key)) {
      this.revalidating.add(key);
      void refresh()
        .catch(() => undefined)
        .finally(() => this.revalidating.delete(key));
    }
    return value;
  }
}

/** Successive differences, which compress to little where values climb steadily. */
export const deltas = (values: ArrayLike<number>) => {
  const out = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++)
    out[i] = values[i] - (i ? values[i - 1] : 0);
  return out;
};

export function sums<T extends Float64Array | Int32Array | Uint32Array>(
  values: number[],
  Type: { new (length: number): T }
): T {
  const out = new Type(values.length);
  for (let i = 0; i < values.length; i++)
    out[i] = values[i] + (i ? out[i - 1] : 0);
  return out;
}
