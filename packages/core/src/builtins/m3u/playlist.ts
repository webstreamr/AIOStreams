import { STREAM, catchupTemplate } from './catchup.js';

/**
 * An extended M3U playlist as Kodi's IPTV Simple Client reads it, which most
 * players and playlists follow; there is no formal standard.
 * https://github.com/kodi-pvr/pvr.iptvsimple#supported-m3u-and-xmltv-elements
 */
export interface Entry {
  name: string;
  url: string;
  tvgId: string;
  tvgName: string;
  logo: string;
  number: string;
  groups: string[];
  /** Seconds the guide's times move, from `tvg-shift` hours. */
  shift: number;
  catchup?: Catchup;
  headers?: Record<string, string>;
}

export interface Catchup {
  template: string;
  days: number;
  /** Seconds taken off a programme's times in its catch-up address. */
  correction: number;
  /** The stream's, with the source's own `|Name=value` over them. */
  headers?: Record<string, string>;
}

export interface Playlist {
  guideUrls: string[];
  entries: Entry[];
}

/** Kodi's default, for catch-up without its days. */
const DEFAULT_CATCHUP_DAYS = 5;
/** Longer stream and catch-up addresses are skipped. */
const MAX_URL = 4096;
/** Names and ids are cut to this, as searches and guide lookups go through them. */
export const MAX_NAME = 256;
/** Headers read from a list at most; players send a few. */
const MAX_HEADERS = 16;
/** Channels read at most; an Xtream provider's movies and series don't count. */
const MAX_CHANNELS = 10_000;
/** Guides kept at most; the guide limit picks the first of them. */
const MAX_GUIDES = 128;

/** Matched only from a name's start, so a long run of name characters stays linear. */
const ATTRIBUTE =
  /(?<![\w-])([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"',]+))/g;

/** Attributes by lowercase name; the first of a name wins. */
function attributes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(ATTRIBUTE))
    out[m[1].toLowerCase()] ??= (m[2] ?? m[3] ?? m[4]).trim();
  return out;
}

/** `#EXTINF:-1 attributes,Name`: the name follows the first comma outside quotes. */
function splitInfo(line: string): [string, string] {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted)
      return [line.slice(0, i), line.slice(i + 1).trim()];
  }
  return [line, ''];
}

const HEADER_NAMES: Record<string, string> = {
  'user-agent': 'User-Agent',
  'http-user-agent': 'User-Agent',
  referer: 'Referer',
  referrer: 'Referer',
  'http-referer': 'Referer',
  'http-referrer': 'Referer',
  origin: 'Origin',
  cookie: 'Cookie',
};

const headerName = (name: string) =>
  HEADER_NAMES[name.toLowerCase()] ?? name.trim();

/** `Name=value&Name=value`, values URL-encoded, as after a stream's `|`. */
function headerList(text: string, into: Record<string, string>) {
  for (const pair of text.split('&', MAX_HEADERS)) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    // Kodi marks headers it doesn't know with `!`.
    const name = headerName(pair.slice(0, at).replace(/^!/, ''));
    let value = pair.slice(at + 1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // Left as it is.
    }
    if (name && value) into[name] = value;
  }
}

const hours = (value: string | undefined) =>
  Math.round((Number(value) || 0) * 3600);

/** Movies and series in an Xtream provider's playlist. */
const XTREAM_VOD = /\/(movie|series)\/[^/]+\/[^/]+\/[^/]+$/;

/** Stops reading at `MAX_CHANNELS` channels. */
export async function parsePlaylist(
  lines: AsyncIterable<string>
): Promise<Playlist> {
  const guideUrls = new Set<string>();
  const entries: Entry[] = [];
  let header: Record<string, string> = {};
  let beginGroups: string[] = [];
  let info: Record<string, string> | undefined;
  let name = '';
  // Options gather until the stream's line, before or after its `#EXTINF`.
  let options: Record<string, string> = {};
  let drm = false;

  for await (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) {
      header = attributes(line.slice(7));
      const guides =
        header['x-tvg-url'] ?? header['url-tvg'] ?? header['tvg-url'] ?? '';
      for (const url of guides.split(/[\s,]+/))
        if (
          guideUrls.size < MAX_GUIDES &&
          /^https?:\/\//i.test(url) &&
          URL.canParse(url)
        )
          guideUrls.add(url);
    } else if (line.startsWith('#EXTINF:')) {
      const [attrs, title] = splitInfo(line.slice(8));
      info = attributes(attrs);
      name = title;
    } else if (line.startsWith('#EXTGRP:')) {
      beginGroups = groupList(line.slice(8));
    } else if (line.startsWith('#EXTVLCOPT')) {
      const [key, ...value] = line.replace(/^#EXTVLCOPT(:|--)/, '').split('=');
      if (/^http-(user-agent|referr?er)$/i.test(key))
        options[headerName(key)] = value.join('=').trim();
    } else if (line.startsWith('#KODIPROP:')) {
      const [key, ...value] = line.slice(10).split('=');
      if (/\.(stream|common)_headers$/.test(key))
        headerList(value.join('='), options);
      else if (/\.license_(type|key)$/.test(key)) drm = true;
    } else if (!line.startsWith('#')) {
      const [url, pipe] = splitPipe(line);
      if (
        info &&
        !drm &&
        url.length <= MAX_URL &&
        STREAM.test(url) &&
        !XTREAM_VOD.test(url)
      ) {
        if (pipe) headerList(pipe, options);
        entries.push(entryOf(info, header, name, url, options, beginGroups));
        if (entries.length >= MAX_CHANNELS) break;
      }
      if (info?.['group-title']) beginGroups = [];
      info = undefined;
      options = {};
      drm = false;
    }
  }
  return { guideUrls: [...guideUrls], entries };
}

/** A channel's groups at most, and a group name's length. */
const MAX_CHANNEL_GROUPS = 8;
const MAX_GROUP_NAME = 100;

const groupList = (text: string) =>
  [
    ...new Set(
      text
        .split(';')
        .map((g) => g.trim().slice(0, MAX_GROUP_NAME))
        .filter(Boolean)
    ),
  ].slice(0, MAX_CHANNEL_GROUPS);

function splitPipe(line: string): [string, string] {
  const at = line.indexOf('|');
  return at < 0 ? [line, ''] : [line.slice(0, at), line.slice(at + 1)];
}

function entryOf(
  info: Record<string, string>,
  header: Record<string, string>,
  title: string,
  url: string,
  headers: Record<string, string>,
  beginGroups: string[]
): Entry {
  const tvgName = (info['tvg-name'] ?? '').slice(0, MAX_NAME);
  const groups = info['group-title']
    ? groupList(info['group-title'])
    : beginGroups;
  return {
    name: (title || tvgName || url).slice(0, MAX_NAME),
    url,
    tvgId: (info['tvg-id'] ?? '').slice(0, MAX_NAME),
    tvgName,
    logo: info['tvg-logo'] ?? '',
    number: info['tvg-chno'] ?? info['ch-number'] ?? '',
    groups,
    shift: hours(info['tvg-shift'] ?? header['tvg-shift']),
    catchup: catchupOf(info, header, url, headers),
    headers: Object.keys(headers).length ? headers : undefined,
  };
}

function catchupOf(
  info: Record<string, string>,
  header: Record<string, string>,
  url: string,
  streamHeaders: Record<string, string>
): Catchup | undefined {
  // SIPTV's `timeshift` and `tvg-rec` give days, and catch-up without a mode.
  const siptvDays =
    Number(info['timeshift']) || Number(info['tvg-rec']) || undefined;
  const mode =
    info['catchup'] ??
    info['catchup-type'] ??
    header['catchup'] ??
    header['catchup-type'] ??
    (siptvDays ? 'shift' : '');
  const full = info['catchup-source'] ?? header['catchup-source'] ?? '';
  // With its headers, as the playlist's own applies to every channel.
  if (full.length > MAX_URL) return undefined;
  const [source, pipe] = splitPipe(full);
  const template = catchupTemplate(mode, source, url);
  if (!template) return undefined;
  const headers = pipe ? { ...streamHeaders } : undefined;
  if (headers) headerList(pipe, headers);
  const days =
    Number(info['catchup-days'] ?? header['catchup-days']) ||
    siptvDays ||
    DEFAULT_CATCHUP_DAYS;
  return {
    template,
    days: Math.min(Math.max(1, Math.floor(days)), 30),
    correction: hours(
      info['catchup-correction'] ?? header['catchup-correction']
    ),
    headers,
  };
}
