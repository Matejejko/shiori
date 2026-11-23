// Release checks: fetch a series' chapter list, update latest/next.

import { withField } from './mangapin.js';
import { getAdapter, listRequest, extractChapters } from './adapters.js';

export const CHECK_INTERVAL_MS = 6 * 3600 * 1000;

/** Cloudflare (and similar) interstitials served with 200/403 instead of the real page. */
export function isBlockedPage(text) {
  const head = String(text).slice(0, 8000);
  return /<title>\s*(Just a moment\.\.\.|Attention Required!|Access denied)/i.test(head)
    || /cf_chl_opt|cf-chl-widget|cf-error-details/i.test(head); // not "challenge-platform": normal pages load that script too
}

/**
 * Apply a fetched chapter list to an entry. Returns the new entry, or null if nothing changed.
 * Only `latest`, `next` and `ts` are touched (never the "rest" fields — see merge.js).
 * @param {Array<{chap:number, slug?:string, id?:string}>} chapters
 */
export function applyChapters(entry, chapters, now = Date.now(), { complete = true } = {}) {
  const valid = chapters.filter((c) => typeof c.chap === 'number' && Number.isFinite(c.chap) && c.chap >= 0);
  if (!valid.length) return null;
  let out = entry;
  let changed = false;
  const max = valid.reduce((a, c) => (c.chap > a.chap ? c : a));
  if (!entry.latest || typeof entry.latest.chap !== 'number' || max.chap > entry.latest.chap) {
    out = withField(out, 'latest', { ...(entry.latest || {}), chap: max.chap, ts: now });
    changed = true;
  }
  const read = entry.progress && typeof entry.progress.chap === 'number' ? entry.progress.chap : -Infinity;
  let ahead = valid.filter((c) => c.chap > read).sort((a, b) => a.chap - b.chap);
  // From a partial list (e.g. Comix exposes only first + latest) the smallest unread chapter
  // is not necessarily the next one: only accept it if it is directly after the read one.
  if (!complete) ahead = ahead.filter((c) => c.chap <= (Number.isFinite(read) ? Math.floor(read) + 1 : 1));
  if (ahead.length) {
    const n = ahead[0];
    if (!entry.next || entry.next.chap !== n.chap) {
      const next = { chap: n.chap };
      if (n.slug) next.slug = n.slug;
      if (n.id) next.id = String(n.id);
      next.ts = now;
      out = withField(out, 'next', next);
      changed = true;
    }
  }
  if (!changed) return null;
  return withField(out, 'ts', Math.max(now, entry.ts || 0));
}

/**
 * Fetch + parse one series. `fetchText(req)` performs a request ({url, method, headers}).
 * @returns {Promise<{chapters: Array<{chap:number, slug?:string, id?:string, url?:string}>, complete: boolean}>}
 */
export async function fetchChapters(entry, fetchText) {
  const reqs = listRequest(entry);
  if (!reqs) throw new Error(`${entry.siteId}: release checks not supported for this site`);
  const all = new Map();
  let ctx = {};
  let complete = false;
  for (const req of reqs) {
    const r = typeof req === 'function' ? req(ctx) : req;
    if (!r) continue;
    const text = await fetchText(r);
    const res = extractChapters(entry, text, r, ctx);
    if (res.ctx) ctx = { ...ctx, ...res.ctx };
    for (const c of res.chapters) if (!all.has(c.chap) || res.complete) all.set(c.chap, c);
    if (res.complete && res.chapters.length) complete = true;
  }
  return { chapters: [...all.values()], complete };
}

/** Which entries are due for a check. `checked` = {id: lastCheckTs}. */
export function dueEntries(lib, { folder = 1, checked = {}, now = Date.now(), interval = CHECK_INTERVAL_MS } = {}) {
  const out = [];
  for (const id of lib.order) {
    const e = lib.entries.get(id);
    if (!e || e.folder !== folder || !getAdapter(e.siteId) || !getAdapter(e.siteId).list) continue;
    if ((checked[id] || 0) + interval > now) continue;
    out.push(e);
  }
  return out;
}
