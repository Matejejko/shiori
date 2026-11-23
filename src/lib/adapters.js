// Declarative site adapters. Each site is data: hosts, URL templates, and how to get the
// chapter list. The engine below turns templates into regexes (parse) and strings (build).
//
// Template placeholders:
//   {slug}  series slug (MangaPin's `slug`)      {chap}  chapter number (10, 10.5)
//   {cslug} chapter slug (MangaPin's progress.slug / next.slug)
//   {cid}   numeric chapter id                   {*}     any single path segment
// Chapter numbers are written per site with `chapSep` ('-' -> 10-5, '.' -> 10.5).
//
// Ground truth for hosts/bases: MangaPin web app sites.json (6.14.0) — see test/fixtures/sites/README.md.

import { SITES } from './sites.js';

const NUM = '\\d{1,5}(?:[.-]\\d{1,3})?';

function compile(template) {
  // template is a path, e.g. "/title/{slug}/{cid}-chapter-{chap}"
  let re = '';
  const names = [];
  for (const part of template.split(/(\{[a-z*]+\})/)) {
    const m = /^\{([a-z*]+)\}$/.exec(part);
    if (!m) { re += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    const n = m[1];
    if (n === '*') re += '[^/]+';
    else if (names.includes(n)) re += `\\k<${n}>`;
    else {
      names.push(n);
      re += n === 'slug' ? '(?<slug>[^/?#]+?)' : n === 'cslug' ? '(?<cslug>[^/?#]+?)' : n === 'cid' ? '(?<cid>\\d+)' : n === 'chap' ? `(?<chap>${NUM})` : '([^/]+)';
    }
  }
  return new RegExp('^' + re + '/?$', 'i');
}

function fill(template, vals) {
  return template.replace(/\{([a-z*]+)\}/g, (_, n) => {
    const v = vals[n];
    if (v === undefined || v === null || v === '') throw new Error('missing ' + n);
    return n === 'slug' || n === 'cslug' ? String(v).split('/').map(encodeURIComponent).join('/') : String(v);
  });
}

export function chapToString(chap, sep = '-') {
  const s = Number.isInteger(chap) ? String(chap) : String(Math.round(chap * 1000) / 1000);
  return s.replace('.', sep);
}
export function parseChapNumber(s) {
  if (s === undefined || s === null) return null;
  const m = /(\d{1,5})(?:[.-](\d{1,3}))?/.exec(String(s));
  if (!m) return null;
  const n = Number(m[2] !== undefined ? `${m[1]}.${m[2]}` : m[1]);
  return Number.isFinite(n) ? n : null;
}

const cache = new Map();
function compiled(site) {
  if (cache.has(site.id)) return cache.get(site.id);
  const c = {
    series: (site.series || []).map((t) => ({ t, re: compile(t) })),
    chapter: (site.chapter || []).map((t) => ({ t, re: compile(t) })),
    hosts: [site.host, ...(site.mirrors || []), ...(site.legacyHosts || [])].map((h) => h.toLowerCase().replace(/^www\./, '')),
  };
  cache.set(site.id, c);
  return c;
}

const bare = (h) => h.toLowerCase().replace(/^www\./, '');

export function getAdapter(siteId) {
  return Object.prototype.hasOwnProperty.call(SITES, siteId) ? { id: siteId, ...SITES[siteId] } : null;
}
export function siteName(siteId) {
  const a = getAdapter(siteId);
  return a ? a.name : siteId;
}
export function allSiteIds() { return Object.keys(SITES); }

/** Adapter for a hostname (current host, mirror or legacy host). */
export function adapterForHost(hostname) {
  const h = bare(hostname);
  for (const id of Object.keys(SITES)) if (compiled({ id, ...SITES[id] }).hosts.includes(h)) return getAdapter(id);
  return null;
}

/**
 * Parse a URL. Returns {siteId, slug, kind:'series'|'chapter', chap?, cslug?, cid?} or null.
 * Chapter templates are tried first (they are more specific).
 */
export function matchUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const a = adapterForHost(u.hostname);
  if (!a) return null;
  const c = compiled(a);
  let path = u.pathname;
  try { path = decodeURI(path); } catch { /* keep raw */ }
  for (const { re } of c.chapter) {
    const m = re.exec(path);
    if (!m) continue;
    const g = m.groups || {};
    let slug = g.slug;
    if (!slug && a.slugFromChapter) slug = a.slugFromChapter(g);
    if (!slug) continue;
    const chap = g.chap !== undefined ? parseChapNumber(g.chap) : parseChapNumber(g.cslug && (a.chapFromCslug ? a.chapFromCslug(g.cslug) : g.cslug));
    if (chap === null) continue;
    const out = { siteId: a.id, slug, kind: 'chapter', chap };
    if (g.cslug) out.cslug = g.cslug;
    if (g.cid) out.cid = g.cid;
    out.chapSlug = a.progressSlug ? a.progressSlug(g) : g.cslug;
    return out;
  }
  for (const { re } of c.series) {
    const m = re.exec(path);
    if (m && m.groups && m.groups.slug) return { siteId: a.id, slug: m.groups.slug, kind: 'series' };
  }
  return { siteId: a.id, slug: null, kind: null };
}

/** Normalised slug for fuzzy matching (sites that append volatile suffixes). */
export function slugKey(siteId, slug) {
  const a = getAdapter(siteId);
  const s = String(slug || '').toLowerCase();
  return a && a.slugKey ? a.slugKey(s) : s;
}

/** Series URL from siteId + slug (an explicit entry.url is NOT consulted here). */
export function seriesUrl(entry) {
  const a = getAdapter(entry.siteId);
  if (!a || !entry.slug || !a.series || !a.series.length) return null;
  try { return `https://${a.host}${fill(a.series[0], { slug: entry.slug })}`; } catch { return null; }
}

/**
 * Chapter URL for an entry and a chapter ({chap, slug?, id?} — MangaPin's next/progress shape).
 * Uses the first chapter template whose placeholders can all be filled.
 */
export function chapterUrl(entry, ch) {
  const a = getAdapter(entry.siteId);
  if (!a || !entry.slug || !ch || typeof ch.chap !== 'number') return null;
  const vals = { slug: entry.slug, chap: chapToString(ch.chap, a.chapSep || '-'), cslug: ch.slug, cid: ch.id };
  if (a.cslugFromProgress && ch.slug) vals.cslug = a.cslugFromProgress(ch.slug);
  for (const t of a.chapterBuild || a.chapter || []) {
    try { return `https://${a.host}${fill(t, vals)}`; } catch { /* try next */ }
  }
  return null;
}

/** What to fetch for the chapter list: array of requests (or functions of ctx -> request). */
export function listRequest(entry) {
  const a = getAdapter(entry.siteId);
  if (!a || !a.list) return null;
  if (a.list.requests) return a.list.requests(entry, a);
  const url = seriesUrl(entry);
  return url ? [{ url }] : null;
}

// Chapter-link extraction from raw HTML/JSON text: every URL-ish string is unescaped and
// matched against the site's chapter templates; only links of *this* series count.
const URLISH = /(?:https?:)?(?:\\?\/\\?\/[a-z0-9.-]+)?(?:\\?\/[A-Za-z0-9._~%!$&'()*+,;=:@-]+)+\\?\/?/g;

function unescapeJsonish(text) {
  return text.replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/').replace(/&#x2[fF];|&#47;/g, '/').replace(/&amp;/g, '&');
}

export function extractChapterLinks(entry, text, baseUrl) {
  const a = getAdapter(entry.siteId);
  if (!a) return [];
  const c = compiled(a);
  const out = new Map();
  const src = unescapeJsonish(text);
  const wantKey = slugKey(entry.siteId, entry.slug);
  for (const m of src.matchAll(URLISH)) {
    let raw = m[0].replace(/\\/g, '');
    let u;
    try { u = new URL(raw, baseUrl || `https://${a.host}/`); } catch { continue; }
    if (!c.hosts.includes(bare(u.hostname))) continue;
    const hit = matchUrl(u.href);
    if (!hit || hit.kind !== 'chapter') continue;
    if (hit.slug !== entry.slug && slugKey(entry.siteId, hit.slug) !== wantKey) continue;
    const key = String(hit.chap);
    if (!out.has(key)) out.set(key, { chap: hit.chap, slug: hit.chapSlug, id: hit.cid, url: u.href });
  }
  return [...out.values()];
}

/** Parse a fetched chapter-list response. Returns {chapters, ctx?}. */
export function extractChapters(entry, text, req, ctx) {
  const a = getAdapter(entry.siteId);
  if (!a || !a.list) return { chapters: [] };
  if (a.list.parse) return a.list.parse(entry, text, req, ctx, { extractChapterLinks, parseChapNumber }) || { chapters: [] };
  return { chapters: extractChapterLinks(entry, text, req.url) };
}
