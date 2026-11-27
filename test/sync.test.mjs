// Two simulated devices syncing through WebDAV. Runs against the in-process fake always,
// and against a real OpenCloud when SHIORI_DAV_URL / SHIORI_DAV_USER / SHIORI_DAV_TOKEN are
// set (or test/opencloud/env exists — created by test/opencloud/start.sh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, MemoryArea } from '../src/lib/store.js';
import { WebDav } from '../src/lib/webdav.js';
import { syncOnce, fromDoc } from '../src/lib/sync.js';
import { planImport, editEntry, setProgress, deleteEntry } from '../src/lib/library.js';
import { libraryFingerprint } from '../src/lib/merge.js';
import { fakeDav } from './fakedav.mjs';
import { exportFixtures, davEnv, storeContent, mangapinContent } from './helpers.mjs';


/** Wrap a WebDav so a callback runs right before the next PUT of library.json. */
function withHook(dav) {
  let hook = null;
  const orig = dav.put.bind(dav);
  dav.put = async (path, body, opts) => {
    if (hook && path.endsWith('/library.json')) { const h = hook; hook = null; await h(); }
    return orig(path, body, opts);
  };
  dav.beforeNextDocPut = (fn) => { hook = fn; };
  return dav;
}


function scenarios(label, makeDav) {
  const fixture = exportFixtures()[0];
  const dir = `ShioriTest-${process.pid}-${Date.now().toString(36)}`;

  test(`[${label}] two devices: import, push, pull, interleaved edits with 412, convergence`, async (t) => {
    const davA = withHook(makeDav()), davB = withHook(makeDav());
    const A = new Store(new MemoryArea()), B = new Store(new MemoryArea());
    const logs = [];
    const log = (s) => logs.push(s);
    t.after(async () => { await davA.delete(dir).catch(() => {}); });

    // laptop imports the MangaPin export and pushes (first write: If-None-Match:* + read-back)
    const plan = planImport(await A.loadLibrary(), new Set(), fixture.text, 'replace');
    await A.saveLibrary(plan.lib);
    await A.putCovers(plan.covers);
    const s1 = await syncOnce({ store: A, dav: davA, dir, log });
    assert.equal(s1.pushed, true);
    assert.equal(s1.coversUp, plan.covers.size);

    // desktop starts empty and pulls everything, covers included: every entry byte for byte
    const s2 = await syncOnce({ store: B, dav: davB, dir, log });
    assert.equal(s2.pushed, false);
    assert.equal(s2.coversDown, plan.covers.size);
    assert.equal(await storeContent(B), mangapinContent(fixture.text));

    // nothing to do on either side now
    const idle = await syncOnce({ store: A, dav: davA, dir, log });
    assert.equal(idle.pushed, false);

    // interleaved edits on the same entry + a delete
    const libA = await A.loadLibrary();
    const [x, y] = libA.order;
    editEntry(libA, x, { tags: ['Tower Climbing', 'Murim'], folder: 2 });
    await A.saveLibrary(libA);

    const libB = await B.loadLibrary();
    const chap = (libB.entries.get(x).progress?.chap ?? 0) + 3;
    setProgress(libB, x, chap, { now: Date.now() + 5 });
    deleteEntry(libB, y, Date.now() + 6);
    await B.saveLibrary(libB);

    // A has already read the doc; B pushes in between -> A's PUT must get 412 and retry
    davA.beforeNextDocPut(async () => { const r = await syncOnce({ store: B, dav: davB, dir, log }); assert.equal(r.pushed, true); });
    const s3 = await syncOnce({ store: A, dav: davA, dir, log });
    assert.ok(s3.conflicts >= 1, 'expected a 412 conflict');
    assert.equal(s3.pushed, true);
    assert.ok(logs.some((l) => l.includes('412')));

    await syncOnce({ store: B, dav: davB, dir, log });
    const fa = await A.loadLibrary(), fb = await B.loadLibrary();
    assert.equal(libraryFingerprint(fa), libraryFingerprint(fb));
    assert.deepEqual(fa.order, fb.order);
    for (const lib of [fa, fb]) {
      assert.deepEqual(lib.entries.get(x).tags, ['Tower Climbing', 'Murim']);
      assert.equal(lib.entries.get(x).folder, 2);
      assert.equal(lib.entries.get(x).progress.chap, chap);
      assert.equal(lib.entries.has(y), false);
      assert.ok(lib.tombs.has(y));
    }
    assert.equal(await storeContent(A), await storeContent(B));

    // the server copy is a Shiori doc with the same content
    const remote = fromDoc((await davA.getText(`${dir}/library.json`)).text);
    assert.equal(libraryFingerprint(remote), libraryFingerprint(fa));
  });

  test(`[${label}] simultaneous first write (server ignores If-None-Match) does not lose data`, async (t) => {
    const d2 = dir + '-race';
    const davA = withHook(makeDav()), davB = withHook(makeDav());
    t.after(async () => { await davA.delete(d2).catch(() => {}); });
    const A = new Store(new MemoryArea()), B = new Store(new MemoryArea());
    const all = planImport(await A.loadLibrary(), new Set(), fixture.text, 'replace');
    // split the library: A has the first half, B the second
    const ids = all.lib.order;
    for (const [store, part] of [[A, ids.slice(0, 50)], [B, ids.slice(50)]]) {
      const lib = { ...all.lib, order: part, entries: new Map(part.map((id) => [id, all.lib.entries.get(id)])), meta: new Map(part.map((id) => [id, all.lib.meta.get(id)])) };
      await store.saveLibrary(lib);
    }
    // both see "no library.json yet"; B's create lands right before A's create
    davA.beforeNextDocPut(async () => { await syncOnce({ store: B, dav: davB, dir: d2 }); });
    await syncOnce({ store: A, dav: davA, dir: d2 });
    await syncOnce({ store: B, dav: davB, dir: d2 });
    await syncOnce({ store: A, dav: davA, dir: d2 });
    const fa = await A.loadLibrary(), fb = await B.loadLibrary();
    assert.equal(fa.entries.size, ids.length);
    assert.equal(libraryFingerprint(fa), libraryFingerprint(fb));
  });

  test(`[${label}] snapshots: the server copy is kept before the day's first overwrite and before a replace import's push`, async (t) => {
    const sdir = dir + '-snap';
    const dav = makeDav();
    t.after(async () => { await dav.delete(sdir).catch(() => {}); });
    const A = new Store(new MemoryArea());
    const plan = planImport(await A.loadLibrary(), new Set(), fixture.text, 'replace');
    await A.saveLibrary(plan.lib); await A.putCovers(plan.covers);
    await syncOnce({ store: A, dav, dir: sdir }); // first write: nothing to keep yet
    const snaps = async () => ((await dav.propfind(`${sdir}/backups/`, 1)) || []).filter((x) => !x.self && !x.dir).map((x) => x.name).sort();
    assert.deepEqual(await snaps(), []);
    const edit = async (chap) => { const lib = await A.loadLibrary(); setProgress(lib, lib.order[0], chap); await A.saveLibrary(lib); };

    const before1 = (await dav.getText(`${sdir}/library.json`)).text;
    await edit(500); await syncOnce({ store: A, dav, dir: sdir });
    const day = new Date().toISOString().slice(0, 10);
    assert.deepEqual(await snaps(), [`library-${day}.json`]);
    assert.equal((await dav.getText(`${sdir}/backups/library-${day}.json`)).text, before1);

    await edit(501); await syncOnce({ store: A, dav, dir: sdir });
    assert.equal((await snaps()).length, 1, 'one daily snapshot');

    const before2 = (await dav.getText(`${sdir}/library.json`)).text;
    await A.setSyncState({ snapNext: true }); // what applying a replace import does
    await edit(502); await syncOnce({ store: A, dav, dir: sdir });
    const pre = (await snaps()).find((n) => n.endsWith('-before-import.json'));
    assert.ok(pre, 'pre-import snapshot');
    const snapText = (await dav.getText(`${sdir}/backups/${pre}`)).text;
    assert.equal(snapText, before2);

    // restoring it: Import -> Replace with the snapshot file
    const B = new Store(new MemoryArea());
    const restore = planImport(await B.loadLibrary(), new Set(), snapText, 'replace');
    assert.equal(restore.summary.kind, 'snapshot');
    assert.equal(restore.lib.entries.get(plan.lib.order[0]).progress.chap, 501);
    assert.equal(restore.lib.entries.size, fromDoc(snapText).entries.size);
  });

  test(`[${label}] refuses to overwrite a non-Shiori library.json`, async (t) => {
    const d3 = dir + '-foreign';
    const dav = makeDav();
    t.after(async () => { await dav.delete(d3).catch(() => {}); });
    await dav.mkcol(d3);
    await dav.mkcol(d3 + '/covers');
    await dav.put(`${d3}/library.json`, '{"something":"else"}', { contentType: 'application/json' });
    const S = new Store(new MemoryArea());
    await assert.rejects(syncOnce({ store: S, dav, dir: d3 }), /not a Shiori library/);
    assert.equal((await dav.getText(`${d3}/library.json`)).text, '{"something":"else"}');
  });

  test(`[${label}] wrong token -> auth error`, async () => {
    const good = makeDav();
    const bad = new WebDav({ url: good.root, user: 'nobody', token: 'wrong', fetch: good.fetch });
    await assert.rejects(syncOnce({ store: new Store(new MemoryArea()), dav: bad, dir }), (e) => e.kind === 'auth');
  });
}

// --- in-process fake (always) ---
{
  const server = fakeDav();
  scenarios('fake', () => new WebDav({ url: server.root, user: server.user, token: server.token, fetch: server.fetch }));
}

// --- real OpenCloud (when configured) ---
const env = davEnv();
if (env) {
  scenarios('opencloud', () => new WebDav({ url: env.url, user: env.user, token: env.token }));
} else {
  test('[opencloud] integration', { skip: 'no SHIORI_DAV_URL/USER/TOKEN and no test/opencloud/env — run test/opencloud/start.sh' }, () => {});
}
