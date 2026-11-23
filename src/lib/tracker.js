// Tab URL -> pinned entry + chapter, and forward-only progress updates. Pure functions.

import { matchUrl, slugKey } from './adapters.js';
import { setProgress } from './library.js';
import { withField } from './mangapin.js';

const CHAP_IN_PATH = /(?:^|[/_-])(?:chapter|chap|ch|episode|ep)[-_ .]?(\d{1,5}(?:[.-]\d{1,2})?)(?=$|[/?#_-])/i;

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch { return ''; }
}
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
 * @returns {{entry: object|null, match: object|null}} match = {siteId, slug, kind, chap?, chapSlug?, chapId?}
 */
export function locate(lib, url) {
  const match = matchUrl(url);
  const entries = [...lib.entries.values()];
  if (match && match.siteId) {
    let entry = entries.find((e) => e.siteId === match.siteId && e.slug === match.slug);
    if (!entry) {
      // MangaPin and the site may disagree on volatile slug parts (e.g. random suffixes)
      const k = slugKey(match.siteId, match.slug);
      entry = entries.find((e) => e.siteId === match.siteId && slugKey(e.siteId, e.slug) === k) || null;
    }
    if (entry || match.kind) return { entry: entry || null, match };
  }
  // generic sites: siteId is the hostname; match via the stored url prefix or the slug in the path
  const host = bareHost(hostOf(url));
  if (!host) return { entry: null, match: null };
  let path;
  try { path = new URL(url).pathname; } catch { return { entry: null, match: null }; }
  for (const e of entries) {
    if (typeof e.siteId !== 'string' || bareHost(e.siteId.toLowerCase()) !== host) continue;
    let hit = false;
    if (typeof e.url === 'string') {
      try {
        const p = new URL(e.url).pathname.replace(/\/+$/, '');
        if (p && (path === p || path.startsWith(p + '/') || path.startsWith(p + '-'))) hit = true;
      } catch { /* ignore */ }
    }
    if (!hit && e.slug && (path.includes('/' + e.slug + '/') || path.endsWith('/' + e.slug) || path.includes('/' + e.slug + '-'))) hit = true;
    if (hit) {
      const rest = path.slice(path.indexOf(e.slug) >= 0 ? path.indexOf(e.slug) + e.slug.length : 0);
      const chap = genericChapter(rest);
      return { entry: e, match: { siteId: e.siteId, slug: e.slug, kind: chap === null ? 'series' : 'chapter', chap: chap ?? undefined, generic: true } };
    }
  }
  return { entry: null, match: match || null };
}

/**
 * Called on every tab URL change. Advances progress of a pinned series (forward only) and
 * bumps `latest` if the user reads past it. Mutates `lib`; returns the entry id if changed.
 */
export function trackVisit(lib, url, now = Date.now()) {
  const { entry, match } = locate(lib, url);
  if (!entry || !match || match.kind !== 'chapter' || typeof match.chap !== 'number') return null;
  const changed = setProgress(lib, entry.id, match.chap, { slug: match.chapSlug, now });
  if (!changed) return null;
  let e = lib.entries.get(entry.id);
  if (!e.latest || typeof e.latest.chap !== 'number' || e.latest.chap < match.chap) {
    const latest = { ...(e.latest || {}), chap: match.chap, ts: e.progress.ts };
    e = withField(e, 'latest', latest);
    lib.entries.set(entry.id, e);
  }
  return entry.id;
}
