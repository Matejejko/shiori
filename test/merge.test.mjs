import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prng } from './helpers.mjs';
import { mergeEntry, mergeLibraries, libraryFingerprint, metaOf, canonical, editTs } from '../src/lib/merge.js';
import { emptyLibrary, editEntry, setProgress, deleteEntry, addEntry } from '../src/lib/library.js';
import { withField } from '../src/lib/mangapin.js';

const R = prng(1234);
const ID = 'AbCdEfGh12';

function baseEntry(ts = 1000) {
  return {
    siteId: 'comix', slug: 'some-series', name: 'Some Series', img: 'local:10:0123456789abcdef0123456789abcdef.webp',
    latest: { chap: 10, ts: ts - 5 }, progress: { chap: 8, ts: ts - 10 }, cLang: 'en', folder: 1, tags: [1], ts, createTs: 1, id: ID,
  };
}

/** Random local operation applied to one device's copy (mirrors what Shiori can do). */
function mutate(entry, meta, now) {
  const lib = emptyLibrary();
  lib.entries.set(ID, entry); lib.meta.set(ID, meta); lib.order = [ID];
  const op = R.int(0, 5);
  if (op === 0) editEntry(lib, ID, { folder: R.pick([1, 2, 4]), tags: [R.int(1, 9)] }, now);
  else if (op === 1) setProgress(lib, ID, (entry.progress?.chap ?? 0) + R.pick([0.5, 1, 2]), { now });
  else if (op === 2) setProgress(lib, ID, R.int(1, 30), { manual: true, now });
  else if (op === 3) { // release check: latest/next + ts bump, rest untouched
    const chap = (entry.latest?.chap ?? 0) + R.int(0, 3);
    let e = withField(entry, 'latest', { chap, ts: now });
    e = withField(e, 'next', { chap: (e.progress?.chap ?? 0) + 1, ts: now });
    e = withField(e, 'ts', Math.max(now, e.ts));
    lib.entries.set(ID, e);
  } else if (op === 4) editEntry(lib, ID, { name: 'Renamed ' + R.int(1, 99), score: R.int(1, 10) }, now);
  else setProgress(lib, ID, (entry.progress?.chap ?? 0) + 1, { slug: 'chapter-x', now });
  return { entry: lib.entries.get(ID), meta: lib.meta.get(ID) };
}

function randomVersions(n) {
  const out = [];
  const root = { entry: baseEntry(), meta: { r: 1000, pe: 0 } };
  for (let i = 0; i < n; i++) {
    let v = root;
    const steps = R.int(0, 4);
    for (let s = 0; s < steps; s++) v = mutate(v.entry, v.meta, 1000 + R.int(1, 50) * 100 + i); // ties happen
    out.push(v);
  }
  return out;
}

const m = (x, y) => mergeEntry(x.entry, x.meta, y.entry, y.meta);
const same = (x, y) => JSON.stringify(x.entry) === JSON.stringify(y.entry) && canonical(x.meta) === canonical(y.meta);

test('mergeEntry is commutative (byte-identical incl. key order)', () => {
  for (let i = 0; i < 3000; i++) {
    const [a, b] = randomVersions(2);
    assert.ok(same(m(a, b), m(b, a)), JSON.stringify([a, b]));
  }
});

test('mergeEntry is idempotent', () => {
  for (let i = 0; i < 2000; i++) {
    const [a, b] = randomVersions(2);
    assert.ok(same(m(a, a), { entry: a.entry, meta: metaOf(a.entry, a.meta) }));
    const ab = m(a, b);
    assert.ok(same(m(ab, b), ab));
    assert.ok(same(m(ab, a), ab));
  }
});

test('mergeEntry is associative', () => {
  for (let i = 0; i < 3000; i++) {
    const [a, b, c] = randomVersions(3);
    assert.ok(same(m(m(a, b), c), m(a, m(b, c))), JSON.stringify([a, b, c]));
  }
});

test('merge never regresses progress and keeps ts >= nested ts', () => {
  for (let i = 0; i < 3000; i++) {
    const [a, b] = randomVersions(2);
    const r = m(a, b);
    const pa = metaOf(a.entry, a.meta).pe, pb = metaOf(b.entry, b.meta).pe;
    const top = Math.max(pa, pb);
    // within the newest progress epoch the result has the furthest chapter
    for (const [v, pe] of [[a, pa], [b, pb]]) {
      if (pe === top && v.entry.progress) assert.ok(r.entry.progress.chap >= v.entry.progress.chap);
    }
    assert.equal(r.meta.pe, top);
    for (const k of ['progress', 'latest', 'next']) if (r.entry[k]?.ts !== undefined) assert.ok(r.entry.ts >= r.entry[k].ts);
    // latest never goes down
    assert.ok((r.entry.latest?.chap ?? -1) >= Math.max(a.entry.latest?.chap ?? -1, b.entry.latest?.chap ?? -1));
  }
});

test('stale offline device reading an old chapter cannot pull progress back', () => {
  const lib = emptyLibrary(); addEntry(lib, baseEntry(1000));
  const laptop = structuredClone(lib), desktop = structuredClone(lib);
  for (let c = 9; c <= 50; c++) setProgress(laptop, ID, c, { now: 2000 + c }); // read up to 50
  setProgress(desktop, ID, 35, { now: 9000 }); // offline for days, catches up to 35 later
  for (const r of [mergeLibraries(laptop, desktop), mergeLibraries(desktop, laptop)]) assert.equal(r.entries.get(ID).progress.chap, 50);
});

test('manual correction backwards wins and later reading continues from it', () => {
  const lib = emptyLibrary(); addEntry(lib, baseEntry(1000));
  const a = structuredClone(lib), b = structuredClone(lib);
  setProgress(a, ID, 50, { now: 2000 });
  setProgress(b, ID, 20, { manual: true, now: 3000 }); // "oops, I'm really on 20"
  setProgress(b, ID, 21, { now: 3100 });
  for (const r of [mergeLibraries(a, b), mergeLibraries(b, a)]) assert.equal(r.entries.get(ID).progress.chap, 21);
});

test('a release check on one machine does not clobber a tag edit made on another', () => {
  const lib = emptyLibrary(); addEntry(lib, baseEntry(1000));
  const a = structuredClone(lib), b = structuredClone(lib);
  editEntry(a, ID, { tags: [7, 8] }, 2000); // laptop, offline
  let e = withField(b.entries.get(ID), 'latest', { chap: 12, ts: 5000 }); // desktop release check, later
  b.entries.set(ID, withField(e, 'ts', 5000));
  for (const r of [mergeLibraries(a, b), mergeLibraries(b, a)]) {
    assert.deepEqual(r.entries.get(ID).tags, [7, 8]);
    assert.equal(r.entries.get(ID).latest.chap, 12);
    assert.equal(r.entries.get(ID).ts, 5000);
  }
});

test('deletes propagate; tombstones lose only to newer user edits', () => {
  const lib = emptyLibrary(); addEntry(lib, baseEntry(1000));
  const a = structuredClone(lib), b = structuredClone(lib);
  deleteEntry(a, ID, 2000);
  for (const r of [mergeLibraries(a, b), mergeLibraries(b, a)]) { assert.equal(r.entries.has(ID), false); assert.equal(r.tombs.get(ID), 2000); }

  // a release check (ts bump only) after the delete does not resurrect
  const c = structuredClone(lib);
  c.entries.set(ID, withField(withField(c.entries.get(ID), 'latest', { chap: 99, ts: 3000 }), 'ts', 3000));
  assert.equal(mergeLibraries(a, c).entries.has(ID), false);

  // a real edit after the delete does
  const d = structuredClone(lib);
  editEntry(d, ID, { folder: 2 }, 3000);
  assert.equal(mergeLibraries(a, d).entries.has(ID), true);
  assert.equal(mergeLibraries(d, a).entries.has(ID), true);
});

test('library merge: commutative, idempotent and multi-device convergent', () => {
  for (let round = 0; round < 200; round++) {
    const devices = [emptyLibrary(), emptyLibrary(), emptyLibrary()];
    let server = emptyLibrary();
    let now = 10_000;
    const ids = ['Aaaaaaaaa1', 'Bbbbbbbbb2', 'Ccccccccc3', 'Ddddddddd4'];
    for (const id of ids) {
      const e = { ...baseEntry(now), id };
      for (const d of devices) if (R.bool(0.7)) addEntry(d, structuredClone(e));
    }
    for (let step = 0; step < 40; step++) {
      now += R.int(0, 3) * 10; // includes equal timestamps
      const d = R.pick(devices);
      const id = R.pick(ids);
      if (R.bool(0.3)) { // sync this device
        const merged = mergeLibraries(server, d);
        server = merged;
        devices[devices.indexOf(d)] = structuredClone(merged);
        continue;
      }
      if (!d.entries.has(id)) { if (R.bool(0.2)) addEntry(d, { ...baseEntry(now), id }); continue; }
      if (R.bool(0.1)) { deleteEntry(d, id, now); continue; }
      const v = mutate(d.entries.get(id), d.meta.get(id), now);
      d.entries.set(id, v.entry); d.meta.set(id, v.meta);
    }
    // commutativity / idempotency of the library merge itself
    const [x, y] = devices;
    assert.equal(libraryFingerprint(mergeLibraries(x, y)), libraryFingerprint(mergeLibraries(y, x)));
    assert.equal(libraryFingerprint(mergeLibraries(x, x)), libraryFingerprint(x));
    // two full sync rounds -> everyone converges on the same library and the same order
    for (let k = 0; k < 2; k++) for (let i = 0; i < devices.length; i++) { server = mergeLibraries(server, devices[i]); devices[i] = structuredClone(server); }
    for (const d of devices) {
      assert.equal(libraryFingerprint(d), libraryFingerprint(server));
      assert.deepEqual(d.order, server.order);
    }
    for (const [id, e] of server.entries) assert.ok(!(server.tombs.get(id) > editTs(e, server.meta.get(id))));
  }
});
