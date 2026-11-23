// Release checks: fetch a series' chapter list, update latest/next.

import { withField } from './mangapin.js';
import { getAdapter, listRequest, extractChapters } from './adapters.js';

export const CHECK_INTERVAL_MS = 6 * 3600 * 1000;

/**
 * Apply a fetched chapter list to an entry. Returns the new entry, or null if nothing changed.
 * Only `latest`, `next` and `ts` are touched (never the "rest" fields — see merge.js).
 * @param {Array<{chap:number, slug?:string, id?:string}>} chapters
 */
export function applyChapters(entry, chapters, now = Date.now()) {
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
  const ahead = valid.filter((c) => c.chap > read).sort((a, b) => a.chap - b.chap);
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
 * Fetch + parse one series. `fetchText(req)` performs the request ({url, method, headers, body}).
 * @returns {Promise<Array<{chap:number, slug?:string, id?:string, url?:string}>>}
 */
export async function fetchChapters(entry, fetchText) {
  const adapter = getAdapter(entry.siteId);
  if (!adapter) throw new Error(`no adapter for ${entry.siteId}`);
  const reqs = listRequest(entry);
  if (!reqs) throw new Error(`${entry.siteId} has no chapter-list method`);
  const all = [];
  let ctx = {};
  for (const req of reqs) {
    const r = typeof req === 'function' ? req(ctx) : req;
    if (!r) continue;
    const text = await fetchText(r);
    const res = extractChapters(entry, text, r, ctx);
    if (res && res.ctx) ctx = { ...ctx, ...res.ctx };
    if (res && res.chapters) all.push(...res.chapters);
  }
  return all;
}

/** Which entries are due for a check. `checked` = {id: lastCheckTs}. */
export function dueEntries(lib, { folder = 1, checked = {}, now = Date.now(), interval = CHECK_INTERVAL_MS } = {}) {
  const out = [];
  for (const id of lib.order) {
    const e = lib.entries.get(id);
    if (!e || e.folder !== folder || !getAdapter(e.siteId)) continue;
    if ((checked[id] || 0) + interval > now) continue;
    out.push(e);
  }
  return out;
}
