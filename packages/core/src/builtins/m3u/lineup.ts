import { Cache } from '../../utils/cache.js';
import { createLogger, getSimpleTextHash } from '../../utils/index.js';
import { config as appConfig } from '../../config/index.js';
import { TieredStore, searchWords } from '../livetv/index.js';
import { download, linesOf, textOf } from './fetch.js';
import { type Catchup, parsePlaylist } from './playlist.js';
import { type Wants, nameKey } from './guide.js';

const logger = createLogger('m3u');

export interface Channel {
  /** Stable across downloads, as stream addresses often carry changing tokens. */
  key: string;
  name: string;
  url: string;
  logo?: string;
  number?: string;
  /** Indexes into the lineup's groups. */
  groups?: number[];
  tvgId?: string;
  tvgName?: string;
  shift?: number;
  catchup?: Catchup;
  headers?: Record<string, string>;
}

interface Stored {
  channels: Channel[];
  groups: string[];
  guideUrls: string[];
}

export interface Lineup extends Stored {
  /** Each group's channels, by index. */
  members: number[][];
  byKey: Map<string, number>;
  /** What its channels want from guides; days back are its longest catch-up. */
  wants: Wants;
  bytes: number;
}

const STALE_SECONDS = 24 * 3600;
/** A failed refresh waits this long before the next, keeping the old list. */
const RETRY_SECONDS = 10 * 60;
/** How long a playlist that failed answers with its error. */
const FAILED_SECONDS = 60;
/** A playlist's groups at most, as its manifest lists them all. */
const MAX_GROUPS = 500;

function derive(stored: Stored): Lineup {
  const members: number[][] = stored.groups.map(() => []);
  const byKey = new Map<string, number>();
  const wanted = new Set<string>();
  let daysBack = 1;
  let bytes = 0;
  stored.channels.forEach((c, i) => {
    byKey.set(c.key, i);
    for (const group of c.groups ?? []) members[group].push(i);
    if (c.tvgId) wanted.add(`i:${c.tvgId.toLowerCase()}`);
    if (c.tvgName) wanted.add(`n:${nameKey(c.tvgName)}`);
    wanted.add(`n:${nameKey(c.name)}`);
    daysBack = Math.max(daysBack, c.catchup?.days ?? 0);
    bytes += 200 + 2 * JSON.stringify(c).length;
  });
  bytes += 2 * JSON.stringify([stored.groups, stored.guideUrls]).length;
  const keys = [...wanted];
  return {
    ...stored,
    members,
    byKey,
    wants: {
      keys,
      id: getSimpleTextHash(`${daysBack}\n${keys.join('\n')}`),
      daysBack,
    },
    bytes,
  };
}

const lineups = new TieredStore<Lineup, Stored>('m3u-lineup', {
  memoryBytes: () => appConfig.builtins.m3u.lineupMemory,
  sizeOf: (l) => l.bytes,
  encode: ({ channels, groups, guideUrls }) => ({
    channels,
    groups,
    guideUrls,
  }),
  decode: derive,
  staleTtl: STALE_SECONDS,
});

const failures = Cache.getInstance<string, string>(
  'm3u-lineup-failed',
  1000,
  'memory'
);

async function fetchLineup(url: string): Promise<Lineup> {
  const { entries, guideUrls } = await parsePlaylist(
    linesOf(
      textOf(
        download(
          url,
          appConfig.builtins.m3u.timeout,
          appConfig.builtins.m3u.playlistMaxBytes
        )
      )
    ),
    appConfig.builtins.m3u.maxChannels,
    appConfig.builtins.m3u.guideUrls
  );
  if (!entries.length) throw new Error('The playlist has no channels');
  const groups: string[] = [];
  const groupIndex = new Map<string, number>();
  const seen = new Map<string, number>();
  const channels = entries.map((e): Channel => {
    const base = getSimpleTextHash(`${e.tvgId}\n${e.name}`).slice(0, 12);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const indexes: number[] = [];
    for (const name of e.groups) {
      let at = groupIndex.get(name);
      if (at === undefined) {
        if (groups.length >= MAX_GROUPS) continue;
        at = groups.length;
        groups.push(name);
        groupIndex.set(name, at);
      }
      indexes.push(at);
    }
    return {
      key: count > 1 ? `${base}-${count}` : base,
      name: e.name,
      url: e.url,
      logo: e.logo || undefined,
      number: e.number || undefined,
      groups: indexes.length ? indexes : undefined,
      tvgId: e.tvgId || undefined,
      tvgName: e.tvgName || undefined,
      shift: e.shift || undefined,
      catchup: e.catchup,
      headers: e.headers,
    };
  });
  return derive({ channels, groups, guideUrls });
}

const keyOf = (url: string) => getSimpleTextHash(url);

function load(url: string, key: string): Promise<Lineup> {
  return lineups.load(
    key,
    async () => ({
      value: await fetchLineup(url),
      ttl: appConfig.builtins.m3u.lineupTtl + STALE_SECONDS,
    }),
    appConfig.builtins.m3u.timeout + 10_000
  );
}

/** A playlist's channels, refreshed in the background once they're old. */
export async function lineupOf(url: string): Promise<Lineup> {
  const key = keyOf(url);
  const failed = await failures.get(key);
  if (failed) throw new Error(failed);
  try {
    return await lineups.getOrRevalidate(
      key,
      () => load(url, key),
      () =>
        load(url, key).then(
          () => undefined,
          async (err) => {
            logger.warn(
              { err: err instanceof Error ? err.message : err },
              'm3u playlist refresh failed'
            );
            const old = await lineups.peek(key);
            if (old)
              await lineups.setLocal(
                key,
                old[0],
                RETRY_SECONDS + STALE_SECONDS
              );
          }
        )
    );
  } catch (err) {
    const message = `M3U playlist failed: ${err instanceof Error ? err.message : err}`;
    // Held briefly, so a broken playlist isn't downloaded on every request.
    await failures.set(key, message, FAILED_SECONDS);
    throw new Error(message);
  }
}

/** The playlist's channel number, else its place in the list. */
export const numberOf = (lineup: Lineup, i: number) =>
  lineup.channels[i].number ?? String(i + 1);

/** Channels whose names hold every word of the term, after the one numbered it. */
export function searchLineup(
  lineup: Lineup,
  term: string,
  limit: number
): number[] {
  const words = searchWords(term);
  if (!words.length) return [];
  const found: number[] = [];
  const number = term.trim();
  const numbered = lineup.channels.findIndex(
    (_, i) => numberOf(lineup, i) === number
  );
  if (numbered >= 0) found.push(numbered);
  for (let i = 0; i < lineup.channels.length && found.length < limit; i++) {
    if (i === numbered) continue;
    const name = lineup.channels[i].name.toLowerCase();
    if (words.every((w) => name.includes(w))) found.push(i);
  }
  return found;
}
