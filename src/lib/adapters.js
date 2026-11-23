// Adapter engine over the declarative table in sites.js: parse URLs, build URLs, extract
// chapter lists from raw HTML/JSON (no DOMParser in service workers, so text + regex).
//
// MangaPin URL rules (from its web app): a slug starting with http(s):// is used as-is
// (host swapped to the site's current host when it is not one of the site's hosts); a slug
// starting with "/" is resolved against the host; otherwise the site's template applies.
// For raw-hostname siteIds (generic sites) MangaPin stores the full path as slug.

import { SITES } from './sites.js';

const bare = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
const isAbs = (s) => /^https?:\/\//i.test(s);

const cache = new Map();
function compiled(id) {
  if (cache.has(id)) return cache.get(id);
  const s = SITES[id];
  const c = {
    seriesRe: (s.seriesRe || []).map((r) => new RegExp(r, 'i')),
    chapterRe: (s.chapterRe || []).map((r) => new RegExp(r, 'i')),
    hosts: [s.host, ...(s.mirrors || []), ...(s.legacyHosts || [])].map(bare),
  };
  cache.set(id, c);
  return c;
}

export function getAdapter(siteId) {
  return typeof siteId === 'string' && Object.prototype.hasOwnProperty.call(SITES, siteId) ? { id: siteId, ...SITES[siteId] } : null;
}
export function siteName(siteId) { const a = getAdapter(siteId); return a ? a.name : siteId; }
export function allSiteIds() { return Object.keys(SITES); }

export function adapterForHost(hostname) {
  const h = bare(hostname);
  for (const id of Object.keys(SITES)) if (compiled(id).hosts.includes(h)) return getAdapter(id);
  return null;
}

export function parseChapNumber(s) {
  if (s === undefined || s === null) return null;
  const m = /(\d{1,5})(?:[.-](\d{1,3}))?/.exec(String(s));
  if (!m) return null;
  const n = Number(m[2] !== undefined ? `${m[1]}.${m[2]}` : m[1]);
  return Number.isFinite(n) ? n : null;
}
export function chapToString(chap, sep = '-') {
  const s = Number.isInteger(chap) ? String(chap) : String(Math.round(chap * 1000) / 1000);
  return s.replace('.', sep);
}

/**
 * Parse a URL. Returns null for unknown hosts, otherwise
 * {siteId, slug, kind:'series'|'chapter'|null, chap?, chapSlug?, cid?}.
 * chap is null on sites whose chapter URLs carry no number (kagane).
 */
export function matchUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const a = adapterForHost(u.hostname);
  if (!a) return null;
  const c = compiled(a.id);
  let path = u.pathname;
  try { path = decodeURI(path); } catch { /* keep raw */ }
  for (const re of c.chapterRe) {
    const m = re.exec(path);
    if (!m || !m.groups || !m.groups.slug) continue;
    const g = m.groups;
    const out = { siteId: a.id, slug: g.slug, kind: 'chapter', chap: g.chap !== undefined ? parseChapNumber(g.chap) : null };
    if (g.cslug) out.chapSlug = g.cslug;
    if (g.cid) out.cid = g.cid;
    return out;
  }
  for (const re of c.seriesRe) {
    const m = re.exec(path);
    if (m && m.groups && m.groups.slug) return { siteId: a.id, slug: m.groups.slug, kind: 'series' };
  }
  return { siteId: a.id, slug: null, kind: null };
}

/**
 * Parse a chapter URL *for a known series* (sites whose chapter paths do not delimit the slug,
 * e.g. MangaThemesia "/{title}-{N}/"). Returns a matchUrl-shaped chapter match or null.
 */
export function matchChapterForSeries(url, siteId, slug) {
  const a = getAdapter(siteId);
  if (!a || !a.chapterForSlug || !slug) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!compiled(a.id).hosts.includes(bare(u.hostname))) return null;
  let path = u.pathname;
  try { path = decodeURI(path); } catch { /* keep raw */ }
  const m = new RegExp(a.chapterForSlug(String(slug).toLowerCase()), 'i').exec(path);
  if (!m) return null;
  const chap = parseChapNumber(m.groups.chap);
  return chap === null ? null : { siteId: a.id, slug, kind: 'chapter', chap, chapSlug: m.groups.cslug };
}

/** The series slug of an entry, resolving MangaPin's URL-or-path slugs for known sites. */
export function entrySlug(entry) {
  const s = String(entry.slug ?? '');
  const a = getAdapter(entry.siteId);
  if (!a || (!isAbs(s) && !s.startsWith('/'))) return s;
  const m = matchUrl(isAbs(s) ? s.replace(/^https?:\/\/[^/]+/i, `https://${a.host}`) : `https://${a.host}${s}`);
  return m && m.slug ? m.slug : s;
}

/** Normalised slug for comparing series (volatile prefixes/suffixes removed). */
export function slugKey(siteId, slug) {
  const a = getAdapter(siteId);
  const s = String(entrySlug({ siteId, slug }) || '').toLowerCase();
  return a && a.slugKey ? a.slugKey(s) : s;
}
export function sameSeries(siteId, slugA, slugB) {
  return slugA === slugB || slugKey(siteId, slugA) === slugKey(siteId, slugB);
}

function fill(template, vals) {
  return template.replace(/\{([a-zA-Z]+)\}/g, (_, n) => {
    const v = vals[n];
    if (v === undefined || v === null || v === '') throw new Error('missing ' + n);
    return n === 'chap' || n === 'cid' ? String(v) : String(v).split('/').map(encodeURIComponent).join('/');
  });
}

function resolveMangaPinUrl(a, s, kind) {
  // Absolute: used as-is on the current host or a live mirror. On a legacy host (which may
  // redirect to the homepage, like asuracomic.net) it is re-parsed and rebuilt on the current
  // template; failing that, the host is swapped (MangaPin's rule).
  let u;
  try { u = new URL(s); } catch { return null; }
  const live = [a.host, ...(a.mirrors || [])].map(bare);
  if (live.includes(bare(u.hostname))) return u.href;
  const m = matchUrl(u.href);
  if (m && m.slug && kind === 'series' && m.kind === 'series') return seriesUrl({ siteId: a.id, slug: m.slug });
  if (m && m.slug && kind === 'chapter' && m.kind === 'chapter') return chapterUrl({ siteId: a.id, slug: m.slug }, { chap: m.chap, slug: m.chapSlug, id: m.cid });
  u.hostname = a.host;
  return u.href;
}

/**
 * Series URL from siteId + slug (MangaPin rules). `link: true` gives the user-facing variant
 * (e.g. Thunderscans without its rotating id, which redirects to the current URL).
 * Generic sites: only when the slug is a path or URL (MangaPin's local-site behaviour).
 */
export function seriesUrl(entry, { link = false } = {}) {
  const s = String(entry.slug ?? '');
  if (!s) return null;
  const a = getAdapter(entry.siteId);
  if (!a) {
    const host = String(entry.siteId || '');
    if (isAbs(s)) return s;
    if (s.startsWith('/') && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return `https://${host}${s}${s.endsWith('/') ? '' : '/'}`;
    return null;
  }
  if (isAbs(s)) return resolveMangaPinUrl(a, s, 'series');
  if (s.startsWith('/')) return `https://${a.host}${s}`;
  const slug = link && a.linkSlug === 'base' && a.slugBase ? a.slugBase(s) : s;
  try { return `https://${a.host}${fill(a.seriesUrl, { slug })}`; } catch { return null; }
}

/**
 * Chapter URL for an entry and a MangaPin chapter object ({chap, slug?, id?}).
 * Tries the site's templates in order; null when no template can be filled (e.g. Comix
 * needs the chapter id, which only the site knows).
 */
export function chapterUrl(entry, ch) {
  if (!ch) return null;
  const a = getAdapter(entry.siteId);
  const cs = ch.slug !== undefined && ch.slug !== null ? String(ch.slug) : '';
  if (!a) {
    if (isAbs(cs)) return cs;
    if (cs.startsWith('/') && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(entry.siteId))) return `https://${entry.siteId}${cs}`;
    return null;
  }
  if (isAbs(cs)) return resolveMangaPinUrl(a, cs, 'chapter');
  if (cs.startsWith('/')) return `https://${a.host}${cs}`;
  const slug = entrySlug(entry);
  const vals = {
    slug, slugBase: a.slugBase ? a.slugBase(slug) : slug, cslug: cs || undefined, cid: ch.id,
    chap: typeof ch.chap === 'number' && Number.isFinite(ch.chap) ? chapToString(ch.chap, a.chapSep || '-') : undefined,
  };
  for (const t of a.chapterUrl || []) {
    try { return `https://${a.host}${fill(t, vals)}`; } catch { /* next template */ }
  }
  return null;
}

/** Requests (or ctx => request functions) that fetch the chapter list; null if unsupported. */
export function listRequest(entry) {
  const a = getAdapter(entry.siteId);
  if (!a || !a.list) return null;
  const e = { ...entry, slug: entrySlug(entry) };
  if (a.list.requests) return a.list.requests(e, a).filter((r) => r !== null);
  const url = seriesUrl(e);
  return url ? [{ url }] : null;
}

// Every URL-ish string in the text (HTML attributes, JSON strings with escaped slashes).
const URLISH = /(?:https?:\/\/[a-z0-9.-]+)?(?:\/[A-Za-z0-9._~%!$&'()*+,;=:@-]+)+\/?/gi;
const unescapeText = (t) => t.replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/').replace(/&#x2[fF];|&#47;/g, '/').replace(/&amp;/g, '&');

/** Chapter links of *this* series found anywhere in a page/JSON body, deduplicated by number. */
export function extractChapterLinks(entry, text, baseUrl) {
  const a = getAdapter(entry.siteId);
  if (!a) return [];
  const hosts = compiled(a.id).hosts;
  const want = slugKey(entry.siteId, entry.slug);
  const out = new Map();
  for (const m of unescapeText(String(text)).matchAll(URLISH)) {
    let u;
    try { u = new URL(m[0], baseUrl || `https://${a.host}/`); } catch { continue; }
    if (!hosts.includes(bare(u.hostname))) continue;
    let hit = matchUrl(u.href);
    if (!hit || hit.kind !== 'chapter' || hit.chap === null || slugKey(a.id, hit.slug) !== want) hit = matchChapterForSeries(u.href, a.id, entry.slug);
    if (!hit || hit.kind !== 'chapter' || hit.chap === null) continue;
    if (!out.has(hit.chap)) out.set(hit.chap, { chap: hit.chap, slug: hit.chapSlug, id: hit.cid, url: u.href });
  }
  return [...out.values()];
}

const helpers = { extractChapterLinks, parseChapNumber };

/** Parse one fetched response. Returns {chapters, complete, ctx?}. */
export function extractChapters(entry, text, req, ctx = {}) {
  const a = getAdapter(entry.siteId);
  if (!a || !a.list) return { chapters: [], complete: false };
  const e = { ...entry, slug: entrySlug(entry) };
  const r = a.list.parse ? a.list.parse(e, text, req, ctx, helpers) || {} : { chapters: extractChapterLinks(e, text, req.url) };
  return { chapters: r.chapters || [], complete: r.complete ?? a.list.complete !== false, ctx: r.ctx };
}
