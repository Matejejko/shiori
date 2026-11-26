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
