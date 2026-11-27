// Tab URL -> pinned entry + chapter, and forward-only progress updates. Pure functions.

import { matchUrl, sameSeries, entrySlug, matchChapterForSeries, slugKey } from './adapters.js';
import { setProgress } from './library.js';
import { withField } from './mangapin.js';

const CHAP_IN_PATH = /(?:^|[/_-])(?:chapter|chap|ch|episode|ep)[-_ .]?(\d{1,5}(?:[.-]\d{1,2})?)(?=$|[/?#_.-])/i;

const bareHost = (h) => h.replace(/^www\./, '');

/** Chapter number from a URL path for generic sites ("chapter-10-5" -> 10.5). */
export function genericChapter(path) {
  const m = CHAP_IN_PATH.exec(path);
  if (!m) return null;
  const n = Number(m[1].replace('-', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Find the library entry a URL belongs to, plus chapter info if it is a chapter page.
 * @returns {{entry: object|null, match: object|null}} match = {siteId, slug, kind, chap?, chapSlug?, cid?}
 */
export function locate(lib, url) {
  const match = matchUrl(url);
  const entries = [...lib.entries.values()];
  if (match) {
    const entry = match.slug ? entries.find((e) => e.siteId === match.siteId && sameSeries(e.siteId, entrySlug(e), match.slug)) : null;
    if (entry) return { entry, match };
    // slug-aware parse against pinned series of this site ("/kaiju-no-8-12/" is ambiguous alone)
    for (const e of entries) {
      if (e.siteId !== match.siteId) continue;
      const hit = matchChapterForSeries(url, e.siteId, entrySlug(e));
      if (hit) return { entry: e, match: hit };
    }
    return { entry: null, match };
  }
  // Generic sites: siteId is the hostname and MangaPin's slug is usually the full path (or a
  // URL); otherwise the stored url, or the slug as a whole path segment. A match must be the
  // whole series path followed by nothing, "/…", or "-chapter-N" — "/read/solo-leveling" must
  // not swallow "/read/solo-leveling-ragnarok/chapter-60". The longest match wins.
  let u;
  try { u = new URL(url); } catch { return { entry: null, match: null }; }
  const host = bareHost(u.hostname);
  let path = u.pathname;
  try { path = decodeURI(path); } catch { /* keep raw */ }
  let best = null;
  for (const e of entries) {
    if (typeof e.siteId !== 'string' || bareHost(e.siteId.toLowerCase()) !== host) continue;
    const s = String(e.slug ?? '');
    const prefixes = [];
    if (/^https?:\/\//i.test(s)) { try { prefixes.push(decodeURI(new URL(s).pathname)); } catch { /* ignore */ } }
    else if (s.startsWith('/')) prefixes.push(s);
    if (typeof e.url === 'string') { try { prefixes.push(decodeURI(new URL(e.url).pathname)); } catch { /* ignore */ } }
    for (const p0 of prefixes) {
      const p = p0.replace(/\/+$/, '');
      if (!p) continue;
      const rest = seriesRest(path, p);
      if (rest !== null && (!best || p.length > best.len)) best = { e, rest, len: p.length };
    }
    if (s && !s.includes('/')) {
      const i = path.indexOf('/' + s);
      if (i >= 0) {
        const rest = seriesRest(path.slice(i), '/' + s);
        if (rest !== null && (!best || s.length + 1 > best.len)) best = { e, rest, len: s.length + 1 };
      }
    }
  }
  if (!best) return { entry: null, match: null };
  const chap = genericChapter(best.rest);
  return { entry: best.e, match: { siteId: best.e.siteId, slug: best.e.slug, kind: chap === null ? 'series' : 'chapter', chap: chap ?? undefined, generic: true } };
}

/** If `path` is the series path `p` (or below it), the remainder; else null. */
function seriesRest(path, p) {
  if (path === p || path === p + '/') return '';
  if (path.startsWith(p + '/')) return path.slice(p.length);
  if (path.startsWith(p + '-') && /^-(?:chapter|chap|ch|episode|ep)[-_.]?\d/i.test(path.slice(p.length))) return path.slice(p.length);
  return null;
}

/**
 * Called on every tab URL change. Advances progress of a pinned series (forward only) and
 * bumps `latest` if the user reads past it. Mutates `lib`; returns the entry id if changed.
 */
export function trackVisit(lib, url, now = Date.now()) {
  const { entry, match } = locate(lib, url);
  if (!entry || !match || match.kind !== 'chapter' || typeof match.chap !== 'number') return null;
  const changed = setProgress(lib, entry.id, match.chap, { slug: match.generic ? undefined : match.chapSlug, now });
  if (!changed) return null;
  let e = lib.entries.get(entry.id);
  if (!e.latest || typeof e.latest.chap !== 'number' || e.latest.chap < match.chap) {
    const latest = { ...(e.latest || {}), chap: match.chap, ts: e.progress.ts };
    e = withField(e, 'latest', latest);
    lib.entries.set(entry.id, e);
  }
  return entry.id;
}

// ---- reading before pinning -------------------------------------------------------------

const GENERIC_CHAPTER_TAIL = /(?:\/|-)(?:chapter|chap|ch|episode|ep)[-_ .]?\d[^/]*(?:\/\d{1,4})?\/?$/i;
export const SEEN_MAX = 100;
export const SEEN_TTL = 30 * 86400e3; // forget reads you never pinned after 30 days

/** Series identity (+ chapter if it is a chapter page) for any URL, pinned or not. */
export function seriesOf(url) {
  const m = matchUrl(url);
  if (m && m.siteId) return m.slug ? { siteId: m.siteId, slug: m.slug, chap: m.kind === 'chapter' ? m.chap : null, chapSlug: m.chapSlug } : null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  // generic site: like MangaPin's local sites, the slug is the series path on that host
  const slug = u.pathname.replace(GENERIC_CHAPTER_TAIL, '').replace(/\/+$/, '') || '/';
  return { siteId: u.hostname, slug, chap: genericChapter(u.pathname), generic: true };
}

export const seenKey = (siteId, slug) => `${siteId}|${slugKey(siteId, slug)}`;

/** The remembered read for a series, unless it has expired. */
export function seenFor(seen, siteId, slug, now = Date.now()) {
  const r = seen && seen[seenKey(siteId, slug)];
  return r && now - r.ts < SEEN_TTL ? r : null;
}

/**
 * Remember the furthest chapter read of a series that is not pinned (local only, never synced).
 * Mutates `seen` ({key: {chap, slug?, ts}}); returns true if it changed.
 */
export function noteSeen(seen, url, now = Date.now()) {
  const s = seriesOf(url);
  if (!s || typeof s.chap !== 'number') return false;
  for (const [x, r] of Object.entries(seen)) if (now - r.ts >= SEEN_TTL) delete seen[x];
  const k = seenKey(s.siteId, s.slug);
  if (seen[k] && seen[k].chap >= s.chap) return false; // forward only
  seen[k] = s.generic || !s.chapSlug ? { chap: s.chap, ts: now } : { chap: s.chap, slug: s.chapSlug, ts: now };
  const keys = Object.keys(seen);
  if (keys.length > SEEN_MAX) {
    keys.sort((a, b) => seen[a].ts - seen[b].ts).slice(0, keys.length - SEEN_MAX).forEach((x) => delete seen[x]);
  }
  return true;
}
