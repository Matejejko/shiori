import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReading } from '../src/lib/stats.js';
import { mergeDays, mergeLibraries } from '../src/lib/merge.js';
import { emptyLibrary, countRead, dayKey } from '../src/lib/library.js';

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();

test('reading log: per-device counts merge by max and sum across devices', () => {
  const a = emptyLibrary(), b = emptyLibrary();
  for (let i = 0; i < 3; i++) countRead(a, 'laptop', at(2026, 11, 20));
  countRead(b, 'desktop', at(2026, 11, 20)); countRead(b, 'desktop', at(2026, 11, 21));
  const ab = mergeLibraries(a, b), ba = mergeLibraries(b, a);
  assert.deepEqual(ab.days, ba.days);
  assert.deepEqual(mergeLibraries(ab, a).days, ab.days); // re-syncing the same counts does not add them twice
  const old = structuredClone(a); countRead(a, 'laptop', at(2026, 11, 20));
  assert.equal(mergeLibraries(ab, mergeLibraries(old, a)).days.laptop['2026-11-20'], 4);
  const r = computeReading(ab.days, at(2026, 11, 21));
  assert.equal(r.today, 1); assert.equal(r.week, 5); assert.equal(r.streak, 2);
  assert.equal(dayKey(at(2026, 1, 5)), '2026-01-05');
  assert.deepEqual(mergeDays({ x: { '2026-01-01': 2 } }, { x: { '2026-01-01': 1 }, y: 'junk' }), { x: { '2026-01-01': 2 } });
});

test('reading log: streaks, month/year totals, Monday weeks', () => {
  const days = { d: { '2026-11-02': 4, '2026-11-03': 1, '2026-11-04': 2, '2026-11-24': 3, '2026-11-25': 5, '2025-12-31': 9 } };
  const r = computeReading(days, at(2026, 11, 26)); // Thursday; nothing read today yet
  assert.equal(r.today, 0);
  assert.equal(r.streak, 2, 'alive from yesterday');
  assert.equal(r.longest, 3);
  assert.equal(r.month, 15);
  assert.equal(r.year, 15);
  assert.equal(r.week, 8);
  assert.equal(r.perWeek.length, 12);
  assert.equal(new Date(r.perWeek.at(-1).start).getDay(), 1);
  assert.equal(r.perWeek.at(-1).chapters, 8);  // Mon 23 – Sun 29
  assert.equal(r.perWeek.at(-4).chapters, 7);  // Mon 2 – Sun 8
  assert.equal(computeReading(days, at(2026, 11, 28)).streak, 0);
  assert.equal(computeReading({}, at(2026, 11, 28)).since, null);
});

test('read-before-pin memory: merges in any order, keeps the furthest chapter, prunes the same way everywhere', async () => {
  const { mergeSeen } = await import('../src/lib/merge.js');
  const { SEEN_MAX, SEEN_TTL } = await import('../src/lib/tracker.js');
  const day = 86400e3, T = Date.UTC(2026, 10, 27);
  const a = { 'arena|x': { chap: 23, slug: 'x-chapter-23', ts: T - day }, 'old|y': { chap: 5, ts: T - SEEN_TTL - 2 * day } };
  const b = { 'arena|x': { chap: 20, slug: 'x-chapter-20', ts: T }, 'asura|z': { chap: 7, ts: T } };
  const c = Object.fromEntries(Array.from({ length: SEEN_MAX }, (_, i) => [`s|n${i}`, { chap: 1, ts: T - day - i }]));
  for (const [x, y, z] of [[a, b, c], [b, c, a], [c, a, b]]) {
    assert.deepEqual(mergeSeen(mergeSeen(x, y), z), mergeSeen(a, mergeSeen(b, c)));
  }
  const m = mergeSeen(a, b);
  assert.deepEqual(m['arena|x'], { chap: 23, slug: 'x-chapter-23', ts: T }); // furthest chapter, latest time
  assert.equal(m['old|y'], undefined);
  assert.equal(Object.keys(mergeSeen(m, c)).length, SEEN_MAX);
});

test('stats: a series read unpinned on one device and pinned on another counts once', async () => {
  const { computeStats } = await import('../src/lib/stats.js');
  const now = Date.now();
  const entries = [{ siteId: 'arena', slug: 'pinned-one', progress: { chap: 30, ts: now }, folder: 1 }];
  const seen = { 'arena|pinned-one': { chap: 23, ts: now }, 'arena|other': { chap: 10, ts: now } };
  const s = computeStats(entries, seen, now);
  assert.equal(s.chapters, 30);
  assert.equal(s.chaptersAll, 40);
  assert.equal(s.unpinnedSeries, 1);
});
