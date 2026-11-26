// Whole-system stress test: three devices, one (fake) WebDAV server, random pins (incl. the same
// series on several devices under different ids and rotating slugs), reads, field edits, deletes,
// backup imports and syncs that collide mid-PUT (real 412s). Afterwards everyone syncs twice and
// the invariants that matter are checked: convergence, one entry per series, no read lost, the
// last edit of every field wins, deletes stay deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, MemoryArea } from '../src/lib/store.js';
import { WebDav } from '../src/lib/webdav.js';
import { syncOnce } from '../src/lib/sync.js';
import { planImport, exportBackup, editEntry, setProgress, deleteEntry, addEntry, newId } from '../src/lib/library.js';
import { libraryFingerprint, seriesKey, metaOf, fieldTime } from '../src/lib/merge.js';
import { fakeDav } from './fakedav.mjs';
import { prng } from './helpers.mjs';

const SERIES = [
  { siteId: 'arena', slugs: ['alpha'] },
  { siteId: 'arena', slugs: ['beta'] },
  { siteId: 'asura', slugs: ['gamma-1a2b3c4d', 'gamma-9f8e7d6c'] }, // rotating hash: one series
];
const keyOf = (s) => seriesKey({ siteId: s.siteId, slug: s.slugs[0] });

for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
  test(`chaos (seed ${seed}): devices converge, one entry per series, no read or edit lost`, async () => {
    const R = prng(seed);
    let clock = Date.UTC(2026, 10, 1);
    const now = () => clock;
    const server = fakeDav({ clock: now });
    const devices = [0, 1, 2].map(() => {
      const store = new Store(new MemoryArea());
      const dav = new WebDav({ url: server.root, user: server.user, token: server.token, fetch: server.fetch });
      return { store, dav };
    });
    const touchedByDelete = new Set(); // series keys: read/edit expectations no longer apply
    const bestRead = new Map();        // series key -> highest chapter read
    const lastFolder = new Map();      // series key -> {t, v}: the folder edit with the latest edit time
    const deletedIds = new Set();

    const sync = (d) => syncOnce({ store: d.store, dav: d.dav, now });
    const op = (d, fn) => d.store.withLock(async () => { const lib = await d.store.loadLibrary(); if (await fn(lib)) await d.store.saveLibrary(lib); });

    for (let step = 0; step < 60; step++) {
      clock += R.int(1, 5) * 1000;
      const d = R.pick(devices);
      const r = R.next();
      if (r < 0.25) {
        // sync; sometimes another device syncs in the middle of this one's PUT -> 412 + retry
        if (R.bool(0.3)) {
          const other = R.pick(devices.filter((x) => x !== d));
          const put = d.dav.put.bind(d.dav);
          let fired = false;
          d.dav.put = async (p, b, o) => { if (!fired && p.endsWith('library.json')) { fired = true; clock += 1; await sync(other); } return put(p, b, o); };
          await sync(d);
          d.dav.put = put;
        } else await sync(d);
      } else if (r < 0.4) {
        const s = R.pick(SERIES);
        const slug = R.pick(s.slugs);
        await op(d, (lib) => {
          if ([...lib.entries.values()].some((e) => seriesKey(e) === keyOf(s))) return false;
          const id = newId(new Set([...lib.entries.keys(), ...lib.tombs.keys()]));
          addEntry(lib, { siteId: s.siteId, slug, name: slug, cLang: 'en', folder: 1, tags: [], ts: clock, createTs: clock, id }, clock);
          return true;
        });
      } else if (r < 0.65) {
        await op(d, (lib) => {
          const id = R.pick([...lib.entries.keys()]);
          if (!id) return false;
          const e = lib.entries.get(id);
          const c = (e.progress?.chap ?? 0) + R.int(1, 3);
          setProgress(lib, id, c, { now: clock });
          bestRead.set(seriesKey(e), Math.max(bestRead.get(seriesKey(e)) ?? 0, c));
          return true;
        });
      } else if (r < 0.85) {
        await op(d, (lib) => {
          const id = R.pick([...lib.entries.keys()]);
          if (!id) return false;
          const e = lib.entries.get(id);
          const v = R.pick([1, 2, 3, 4, 5]);
          if (R.bool(0.5)) editEntry(lib, id, { folder: v }, clock);
          else { editEntry(lib, id, { tags: [R.int(1, 9)] }, clock); return true; }
          const t = fieldTime(metaOf(lib.entries.get(id), lib.meta.get(id)), 'folder');
          const k = seriesKey(e), prev = lastFolder.get(k);
          if (!prev || t >= prev.t) lastFolder.set(k, { t, v }); // equal times: either may win; checked loosely below
          return true;
        });
      } else if (r < 0.93) {
        await op(d, (lib) => {
          const id = R.pick([...lib.entries.keys()]);
          if (!id) return false;
          touchedByDelete.add(seriesKey(lib.entries.get(id)));
          deletedIds.add(id);
          return deleteEntry(lib, id, clock);
        });
      } else {
        // merge-import a backup taken from another device right now
        const other = R.pick(devices.filter((x) => x !== d));
        const lib = await other.store.loadLibrary();
        const covers = await other.store.getCovers(await other.store.coverKeys());
        const text = exportBackup(lib, (k) => covers.get(k), clock);
        await d.store.withLock(async () => {
          const plan = planImport(await d.store.loadLibrary(), new Set(await d.store.coverKeys()), text, 'merge', clock);
          await d.store.putCovers(plan.covers);
          await d.store.saveLibrary(plan.lib);
        });
      }
    }

    for (let round = 0; round < 2; round++) for (const d of devices) { clock += 1000; await sync(d); }
    const libs = await Promise.all(devices.map((d) => d.store.loadLibrary()));
    for (const l of libs) assert.equal(libraryFingerprint(l), libraryFingerprint(libs[0]), 'devices converge');
    for (const l of libs) assert.deepEqual(l.order, libs[0].order, 'same order everywhere');
    const lib = libs[0];
    const bySeries = new Map([...lib.entries.values()].map((e) => [seriesKey(e), e]));
    assert.equal(bySeries.size, lib.entries.size, 'one entry per series');
    for (const id of deletedIds) assert.equal(lib.entries.has(id), false, `deleted id ${id} came back`);
    for (const [k, c] of bestRead) {
      if (touchedByDelete.has(k) || !bySeries.has(k)) continue;
      assert.ok(bySeries.get(k).progress.chap >= c, `${k}: read of ch${c} lost (have ${bySeries.get(k).progress.chap})`);
    }
    for (const [k, { v }] of lastFolder) {
      if (touchedByDelete.has(k) || !bySeries.has(k)) continue;
      assert.equal(bySeries.get(k).folder, v, `${k}: latest folder edit lost`);
    }
  });
}
