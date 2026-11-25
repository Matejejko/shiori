// Library statistics for the Stats page. Pure: entries (+ the local "read before pinning"
// memory) in, numbers out.

import { SEEN_TTL } from './tracker.js';

// Shiori does not time your reading; hours are an estimate from chapters read.
export const MIN_PER_CHAPTER = 2.5;
const DAY = 86400e3;

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const read = (e) => (num(e.progress?.chap) ? Math.floor(e.progress.chap) : 0);

function top(map, n) {
  return [...map].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n);
}

export function computeStats(entries, seen = {}, now = Date.now()) {
  const chapters = entries.reduce((s, e) => s + read(e), 0);
  const unpinned = Object.values(seen || {}).filter((r) => r && num(r.chap) && now - r.ts < SEEN_TTL);
  const unpinnedChapters = unpinned.reduce((s, r) => s + Math.floor(r.chap), 0);
  const folders = new Map(), sites = new Map(), tags = new Map();
  let waiting = 0, withNew = 0, notStarted = 0, activeWeek = 0, added30 = 0, finishedYear = 0, longest = null;
  const scores = [];
  const year = new Date(now).getFullYear();
  for (const e of entries) {
    folders.set(e.folder, (folders.get(e.folder) || 0) + 1);
    sites.set(e.siteId, (sites.get(e.siteId) || 0) + read(e));
    for (const t of Array.isArray(e.tags) ? e.tags : []) tags.set(t, (tags.get(t) || 0) + 1);
    const p = e.progress?.chap, l = e.latest?.chap;
    if (!num(p)) notStarted++;
    if (num(p) && num(l) && l > p) { waiting += l - p; withNew++; }
    if (num(e.progress?.ts) && now - e.progress.ts < 7 * DAY) activeWeek++;
    if (num(e.createTs) && now - e.createTs < 30 * DAY) added30++;
    if (num(e.endTs) && new Date(e.endTs).getFullYear() === year) finishedYear++;
    if (num(e.score)) scores.push(e.score);
    if (num(p) && (!longest || p > longest.progress.chap)) longest = e;
  }
  return {
    chapters,
    chaptersAll: chapters + unpinnedChapters,
    unpinnedSeries: unpinned.length,
    hours: (chapters * MIN_PER_CHAPTER) / 60,
    series: entries.length,
    folders, // folder number -> series
    waiting: Math.round(waiting * 10) / 10,
    withNew, notStarted, activeWeek, added30, finishedYear,
    avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    scored: scores.length,
    topSites: top(sites, 3).filter(([, c]) => c > 0), // [siteId, chapters]
    topTags: top(tags, 8), // [tag, series]
    longest: longest ? { name: longest.name, chap: longest.progress.chap } : null,
  };
}
