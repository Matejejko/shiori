// Library statistics for the Stats page. Pure: entries (+ the local "read before pinning"
// memory) in, numbers out.

import { SEEN_TTL, seenKey } from './tracker.js';

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
  // a series pinned since (on any device) is counted once, as pinned
  const pinned = new Set(entries.map((e) => seenKey(e.siteId, e.slug)));
  const unpinned = Object.entries(seen || {}).filter(([k, r]) => !pinned.has(k) && r && num(r.chap) && now - r.ts < SEEN_TTL).map(([, r]) => r);
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

// ---- reading log (chapters per day, see mergeDays) ------------------------------------------

const dayOf = (t) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
const keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/**
 * @param {Object<string, Object<string, number>>} days  { device: { 'YYYY-MM-DD': chapters } }
 * @returns totals for today / 7 days / month / year, streaks, and the last `weeks` Monday-weeks
 */
export function computeReading(days, now = Date.now(), weeks = 12) {
  const total = new Map(); // day -> chapters, all devices
  for (const dev of Object.values(days || {})) {
    if (!dev || typeof dev !== 'object') continue;
    for (const [d, n] of Object.entries(dev)) if (num(n) && n > 0) total.set(d, (total.get(d) || 0) + n);
  }
  const today = dayOf(now);
  const at = (d) => total.get(keyOf(d)) || 0;
  const sumFrom = (start) => { let s = 0; for (const [k, n] of total) if (k >= keyOf(start) && k <= keyOf(today)) s += n; return s; };

  // current streak: today counts if you read today, else it is still alive from yesterday
  let streak = 0;
  for (let d = at(today) ? today : addDays(today, -1); at(d) > 0; d = addDays(d, -1)) streak++;
  let longest = 0, run = 0, prev = null;
  for (const k of [...total.keys()].sort()) {
    const d = new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
    run = prev && keyOf(addDays(prev, 1)) === k ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }

  const monday = addDays(today, -((today.getDay() + 6) % 7));
  const perWeek = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const start = addDays(monday, -7 * w);
    let n = 0;
    for (let i = 0; i < 7; i++) n += at(addDays(start, i));
    perWeek.push({ start: start.getTime(), chapters: n });
  }
  const first = [...total.keys()].sort()[0] || null;
  return {
    today: at(today),
    week: sumFrom(addDays(today, -6)),
    month: sumFrom(new Date(today.getFullYear(), today.getMonth(), 1)),
    year: sumFrom(new Date(today.getFullYear(), 0, 1)),
    streak, longest, perWeek,
    since: first ? new Date(+first.slice(0, 4), +first.slice(5, 7) - 1, +first.slice(8, 10)).getTime() : null,
  };
}
