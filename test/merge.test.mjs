import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prng } from './helpers.mjs';
import { mergeEntry, mergeLibraries, libraryFingerprint, metaOf, canonical, editTs } from '../src/lib/merge.js';
import { emptyLibrary, editEntry, setProgress, deleteEntry, addEntry } from '../src/lib/library.js';
import { withField } from '../src/lib/mangapin.js';
import { applyChapters } from '../src/lib/releases.js';

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
  else if (op === 3) { // release check (the real one): latest/next + ts bump, rest untouched
    const top = (entry.latest?.chap ?? 0) + R.int(0, 3);
    const chapters = Array.from({ length: 6 }, (_, k) => ({ chap: top - k, slug: `c-${top - k}` }));
    const e = applyChapters(entry, chapters, now, { complete: R.bool(0.7) });
    if (e) lib.entries.set(ID, e);
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

// Oracle for progress: every progress value a version has ever held is a read event; the
// answer is the furthest chapter among events at/after the latest manual correction.
function events(v) {
  const m = metaOf(v.entry, v.meta);
  return { pm: m.pm ?? -Infinity, ev: [v.entry.progress, ...(m.pf || [])].filter(Boolean) };
}
test('progress = furthest chapter read since the last manual correction; ts >= nested ts', () => {
  for (let i = 0; i < 4000; i++) {
    const vs = randomVersions(R.int(2, 3));
    const r = vs.slice(1).reduce((acc, v) => m(acc, v), vs[0]);
    const all = vs.map(events);
    const pm = Math.max(...all.map((x) => x.pm));
    const eligible = all.flatMap((x) => x.ev).filter((p) => pm === -Infinity || p.ts >= pm);
    const best = Math.max(...eligible.map((p) => p.chap));
    assert.equal(r.entry.progress.chap, best, JSON.stringify(vs));
    assert.equal(metaOf(r.entry, r.meta).pm ?? -Infinity, pm);
    for (const k of ['progress', 'latest', 'next']) if (r.entry[k]?.ts !== undefined) assert.ok(r.entry.ts >= r.entry[k].ts);
    assert.ok((r.entry.latest?.chap ?? -1) >= Math.max(...vs.map((v) => v.entry.latest?.chap ?? -1)));
  }
});

test('reads made after a correction on a device that had not seen it still count', () => {
  const lib = emptyLibrary(); addEntry(lib, baseEntry(100));
  const a = structuredClone(lib), b = structuredClone(lib);
  setProgress(a, ID, 25, { manual: true, now: 200 });
  for (let c = 9; c <= 40; c++) setProgress(b, ID, c, { now: 300 + c });
  for (const r of [mergeLibraries(a, b), mergeLibraries(b, a)]) assert.equal(r.entries.get(ID).progress.chap, 40);
});

test('three-way merge with nested corrections is order independent (frontier keeps late reads)', () => {
  // a: corrected at 100, read to 50 by t=150; b: never saw a correction, read 30 at t=400;
  // c: corrected to 20 at t=300. Truth: since t=300 the furthest read is b's 30.
  const mk = (chap, ts, pm) => ({ entry: { ...baseEntry(ts), progress: { chap, ts } }, meta: pm === undefined ? { r: 1 } : { r: 1, pm } });
  const a = mk(50, 150, 100), b = mk(30, 400), c = mk(20, 300, 300);
  for (const r of [m(m(a, b), c), m(a, m(b, c)), m(m(a, c), b), m(c, m(b, a))]) assert.equal(r.entry.progress.chap, 30);
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

test('deletes are final everywhere; only an explicit restore beats them', () => {
  const lib = emptyLibrary(); addEntry(lib, baseEntry(1000));
  const a = structuredClone(lib), b = structuredClone(lib);
  deleteEntry(a, ID, 2000);
  for (const r of [mergeLibraries(a, b), mergeLibraries(b, a)]) { assert.equal(r.entries.has(ID), false); assert.equal(r.tombs.get(ID), 2000); }

  // a release check (ts bump only) after the delete does not resurrect
  const c = structuredClone(lib);
  c.entries.set(ID, withField(withField(c.entries.get(ID), 'latest', { chap: 99, ts: 3000 }), 'ts', 3000));
  assert.equal(mergeLibraries(a, c).entries.has(ID), false);

  // neither does reading or editing it on a device that had not seen the delete yet
  // (e.g. a restored browser tab on the old site after you moved the series to another)
  const d = structuredClone(lib);
  editEntry(d, ID, { folder: 2 }, 3000);
  setProgress(d, ID, 40, { now: 3100 });
  assert.equal(mergeLibraries(a, d).entries.has(ID), false);
  assert.equal(mergeLibraries(d, a).entries.has(ID), false);

  // a restore (replace import) after the delete does, and survives the other device's tombstone
  const e = structuredClone(lib);
  e.meta.set(ID, { ...e.meta.get(ID), rs: 4000, u: 4000 });
  for (const r of [mergeLibraries(a, e), mergeLibraries(e, a)]) assert.equal(r.entries.has(ID), true);
  // and deleting it again after the restore works
  const f = mergeLibraries(a, e); deleteEntry(f, ID, 5000);
  assert.equal(mergeLibraries(f, e).entries.has(ID), false);
});

test('library merge: commutative, idempotent and multi-device convergent', () => {
  for (let round = 0; round < 200; round++) {
    const devices = [emptyLibrary(), emptyLibrary(), emptyLibrary()];
    let server = emptyLibrary();
    let now = 10_000;
    const ids = ['Aaaaaaaaa1', 'Bbbbbbbbb2', 'Ccccccccc3', 'Ddddddddd4'];
    for (const id of ids) {
      const e = { ...baseEntry(now), id, slug: `s${id}` };
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
      if (!d.entries.has(id)) { if (!d.tombs.has(id) && R.bool(0.2)) addEntry(d, { ...baseEntry(now), id, slug: `s${id}` }); continue; }
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
    for (const [id] of server.entries) assert.ok(!(server.tombs.get(id) > (server.meta.get(id)?.rs ?? -Infinity)));
  }
});

test('same series under different ids (pinned on two devices, or imported) converges to one entry', () => {
  for (let round = 0; round < 300; round++) {
    const ids = ['Kkkkkkkkk1', 'Bbbbbbbbb2', 'Zzzzzzzzz3'];
    const devices = ids.map((id) => {
      const d = emptyLibrary();
      addEntry(d, { ...baseEntry(1000 + R.int(0, 50)), id, slug: 'one-series' });
      return d;
    });
    let server = emptyLibrary();
    let now = 5000;
    for (let step = 0; step < 30; step++) {
      now += R.int(0, 3) * 10;
      const i = R.int(0, devices.length - 1);
      const d = devices[i];
      if (R.bool(0.4)) { server = mergeLibraries(server, d); devices[i] = structuredClone(server); continue; }
      const [id] = d.entries.keys();
      if (!id) continue;
      const v = mutate(d.entries.get(id), d.meta.get(id), now);
      d.entries.set(id, v.entry); d.meta.set(id, v.meta);
    }
    for (let k = 0; k < 2; k++) for (let i = 0; i < devices.length; i++) { server = mergeLibraries(server, devices[i]); devices[i] = structuredClone(server); }
    for (const d of devices) assert.equal(libraryFingerprint(d), libraryFingerprint(server));
    assert.equal(server.entries.size, 1);
    assert.equal([...server.entries.keys()][0], 'Bbbbbbbbb2'); // smallest id survives, everywhere
  }
});

test('reading on an offline device survives the duplicate it was made on being folded away', () => {
  // A pinned the series as K, B as D; C has an old copy of D and reads chapter 30 offline.
  const S = (id, ts) => ({ ...baseEntry(ts), id, slug: 'one-series' });
  const A = emptyLibrary(); addEntry(A, S('Kkkkkkkkk1', 50));
  const B = emptyLibrary(); addEntry(B, S('Zzzzzzzzz3', 60));
  const C = structuredClone(B);
  setProgress(C, 'Zzzzzzzzz3', 30, { now: 90 });
  editEntry(B, 'Zzzzzzzzz3', { folder: 2 }, 100); // newer than C's read
  for (const server of [mergeLibraries(mergeLibraries(A, B), C), mergeLibraries(A, mergeLibraries(B, C)), mergeLibraries(mergeLibraries(C, A), B)]) {
    assert.equal(server.entries.size, 1);
    const e = server.entries.get('Kkkkkkkkk1');
    assert.equal(e.progress.chap, 30);
    assert.equal(e.folder, 2);
  }
});

test('series de-duplication through the server: commutative, convergent, and no read is ever lost', () => {
  const ids = ['Aaaaaaaaa1', 'Bbbbbbbbb2', 'Ccccccccc3', 'Ddddddddd4', 'Eeeeeeeee5'];
  const slugs = ['sone', 'stwo']; // 5 ids over 2 series: lots of duplicates
  for (let round = 0; round < 300; round++) {
    const devices = [emptyLibrary(), emptyLibrary(), emptyLibrary()];
    const best = new Map(); // series -> highest chapter read anywhere
    const deleted = new Set();
    let now = 10_000;
    for (const id of ids) {
      const e = { ...baseEntry(now), id, slug: R.pick(slugs) };
      for (const d of devices) if (R.bool(0.4)) addEntry(d, structuredClone(e));
    }
    let server = emptyLibrary();
    for (let step = 0; step < 40; step++) {
      now += R.int(0, 3) * 10;
      const i = R.int(0, 2), d = devices[i];
      if (R.bool(0.3)) { server = mergeLibraries(server, d); devices[i] = structuredClone(server); continue; }
      const id = R.pick([...d.entries.keys()]);
      if (!id) continue;
      const e = d.entries.get(id);
      if (R.bool(0.08)) { deleteEntry(d, id, now); deleted.add(e.slug); continue; }
      if (R.bool(0.5)) editEntry(d, id, { folder: R.pick([1, 2, 4]) }, now);
      else { const c = (e.progress?.chap ?? 0) + R.int(1, 3); setProgress(d, id, c, { now }); best.set(e.slug, Math.max(best.get(e.slug) ?? 0, c)); }
    }
    const [x, y, z] = devices;
    // Not asserted: associativity over arbitrary device states. A copy deleted by a fold
    // tombstone is merged into its survivor only if the two meet in the same merge, which
    // through the server (it always holds the survivor) they do; two devices merging each
    // other directly could drop such a copy's off-frontier read history (never its chapter).
    void z;
    assert.equal(libraryFingerprint(mergeLibraries(x, y)), libraryFingerprint(mergeLibraries(y, x)));
    for (let k = 0; k < 2; k++) for (let i = 0; i < 3; i++) { server = mergeLibraries(server, devices[i]); devices[i] = structuredClone(server); }
    for (const d of devices) assert.equal(libraryFingerprint(d), libraryFingerprint(server));
    const bySlug = new Map([...server.entries.values()].map((e) => [e.slug, e]));
    assert.equal(bySlug.size, server.entries.size, 'one entry per series');
    for (const [slug, c] of best) if (!deleted.has(slug)) assert.ok(bySlug.get(slug).progress.chap >= c, `read of ${slug} ch${c} lost (have ${bySlug.get(slug).progress.chap})`);
  }
});
