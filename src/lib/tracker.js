// Tab URL -> pinned entry + chapter, and forward-only progress updates. Pure functions.

import { matchUrl, sameSeries, entrySlug } from './adapters.js';
import { setProgress } from './library.js';
import { withField } from './mangapin.js';

const CHAP_IN_PATH = /(?:^|[/_-])(?:chapter|chap|ch|episode|ep)[-_ .]?(\d{1,5}(?:[.-]\d{1,2})?)(?=$|[/?#_-])/i;

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
    if (!match.slug) return { entry: null, match };
    const entry = entries.find((e) => e.siteId === match.siteId && sameSeries(e.siteId, entrySlug(e), match.slug)) || null;
    return { entry, match };
  }
  // Generic sites: siteId is the hostname and MangaPin's slug is usually the full path (or a
  // URL); otherwise fall back to the stored url or the slug as a path segment.
  let u;
  try { u = new URL(url); } catch { return { entry: null, match: null }; }
  const host = bareHost(u.hostname);
  const path = u.pathname;
  for (const e of entries) {
    if (typeof e.siteId !== 'string' || bareHost(e.siteId.toLowerCase()) !== host) continue;
    const s = String(e.slug ?? '');
    const prefixes = [];
    if (/^https?:\/\//i.test(s)) { try { prefixes.push(new URL(s).pathname); } catch { /* ignore */ } }
    else if (s.startsWith('/')) prefixes.push(s);
    if (typeof e.url === 'string') { try { prefixes.push(new URL(e.url).pathname); } catch { /* ignore */ } }
    let rest = null;
    for (const p0 of prefixes) {
      const p = p0.replace(/\/+$/, '');
      if (p && (path === p || path === p + '/' || path.startsWith(p + '/') || path.startsWith(p + '-'))) { rest = path.slice(p.length); break; }
    }
    if (rest === null && s && !s.includes('/')) {
      const i = path.indexOf('/' + s);
      const after = i >= 0 ? path[i + 1 + s.length] : undefined;
      if (i >= 0 && (after === undefined || after === '/' || after === '-')) rest = path.slice(i + 1 + s.length);
    }
    if (rest === null) continue;
    const chap = genericChapter(rest);
    return { entry: e, match: { siteId: e.siteId, slug: e.slug, kind: chap === null ? 'series' : 'chapter', chap: chap ?? undefined, generic: true } };
  }
  return { entry: null, match: null };
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
