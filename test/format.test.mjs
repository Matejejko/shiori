import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportFixtures, realExportPresent, storeContent, mangapinContent } from './helpers.mjs';
import { parseExport, exportFileName, parseCoverKey, coverKeyFor, coverKeyToFile, coverFileToKey, withField } from '../src/lib/mangapin.js';
import { b64ToBytes, bytesToB64 } from '../src/lib/base64.js';
import { md5 } from '../src/lib/md5.js';
import { createHash, randomBytes } from 'node:crypto';
import { Store, MemoryArea } from '../src/lib/store.js';
import { planImport, exportBackup, emptyLibrary, setProgress } from '../src/lib/library.js';
import { fromDoc } from '../src/lib/sync.js';
import { metaOf, canonical } from '../src/lib/merge.js';

test('real export present (informational)', (t) => {
  if (!realExportPresent()) t.diagnostic('No real MangaPin export found: only the synthetic fixture is tested. Put yours in test/fixtures/private/ or set SHIORI_EXPORT.');
});

test('md5 matches node:crypto on random inputs', () => {
  for (let n = 0; n < 200; n++) {
    const b = new Uint8Array(randomBytes(n * 13));
    assert.equal(md5(b), createHash('md5').update(b).digest('hex'));
  }
});

test('base64 round-trips', () => {
  for (let n = 0; n < 100; n++) {
    const b = new Uint8Array(randomBytes(n));
    const s = bytesToB64(b);
    assert.equal(s, Buffer.from(b).toString('base64'));
    assert.deepEqual(b64ToBytes(s), b);
    assert.deepEqual(b64ToBytes('data:image/webp;base64,' + s), b);
  }
});

test('cover key helpers', () => {
  const b = new Uint8Array([1, 2, 3]);
  const k = coverKeyFor(b);
  assert.match(k, /^local:3:[0-9a-f]{32}\.webp$/);
  assert.deepEqual(parseCoverKey(k), { bytes: 3, md5: md5(b) });
  assert.equal(coverFileToKey(coverKeyToFile(k)), k);
  assert.equal(parseCoverKey('https://x/y.jpg'), null);
});

test('export filename format', () => {
  assert.equal(exportFileName(new Date(2026, 0, 5, 7, 9)), 'Shiori-05012026.json');
});

test('withField keeps existing order and inserts new keys in MangaPin order', () => {
  const e = { siteId: 'a', slug: 'b', name: 'n', cLang: 'en', ts: 1, id: 'x' };
  assert.deepEqual(Object.keys(withField(e, 'progress', {})), ['siteId', 'slug', 'name', 'progress', 'cLang', 'ts', 'id']);
  assert.deepEqual(Object.keys(withField(e, 'name', 'z')), Object.keys(e));
  assert.deepEqual(Object.keys(withField(e, 'zzz', 1)), [...Object.keys(e), 'zzz']);
});

test('unknown entry fields survive import -> backup -> import, field order included', () => {
  const src = JSON.stringify({ version: 1, entries: [{ id: 'AAAAAAAAAA', siteId: 's', slug: 'x', name: '“q”   </script>', zz: { y: 1, x: 2 }, ts: 5 }], imgs: {} });
  const plan = planImport(emptyLibrary(), new Set(), src, 'replace');
  const backup = exportBackup(plan.lib, () => undefined);
  const again = planImport(emptyLibrary(), new Set(), backup, 'replace');
  assert.equal(again.summary.kind, 'shiori');
  assert.equal(JSON.stringify(again.lib.entries.get('AAAAAAAAAA')), JSON.stringify(JSON.parse(src).entries[0]));
});

test('import refuses a file of the other kind than the one chosen', () => {
  const backup = exportBackup(emptyLibrary(), () => undefined);
  const mp = JSON.stringify({ version: 1, entries: [{ id: 'AAAAAAAAAA', siteId: 's', slug: 'x', name: 'n', ts: 1 }], imgs: {} });
  assert.throws(() => planImport(emptyLibrary(), new Set(), mp, 'merge', 1, 'shiori'), /MangaPin export/);
  assert.throws(() => planImport(emptyLibrary(), new Set(), backup, 'merge', 1, 'mangapin'), /Shiori file/);
  assert.equal(planImport(emptyLibrary(), new Set(), mp, 'merge', 1, 'mangapin').summary.kind, 'mangapin');
  assert.equal(planImport(emptyLibrary(), new Set(), backup, 'merge', 1, 'shiori').summary.kind, 'shiori');
});

test('a backup or library.json from a newer Shiori is refused, not misread', () => {
  const b = JSON.parse(exportBackup(emptyLibrary(), () => undefined));
  assert.throws(() => planImport(emptyLibrary(), new Set(), JSON.stringify({ ...b, version: 99 }), 'merge'), /newer Shiori/);
  assert.throws(() => planImport(emptyLibrary(), new Set(), JSON.stringify({ ...b, library: { ...b.library, version: 99 } }), 'merge'), /newer Shiori/);
  assert.throws(() => fromDoc(JSON.stringify({ ...b.library, version: 99 })), /newer Shiori/);
});

for (const fx of exportFixtures()) {
  test(`[${fx.name}] parses cleanly`, (t) => {
    const p = parseExport(fx.text);
    t.diagnostic(`${p.entries.length} entries, ${p.imgs.size} covers, problems=${p.problems.length}`);
    for (const pr of p.problems.slice(0, 20)) t.diagnostic('problem: ' + pr);
    assert.ok(p.entries.length > 0);
  });

  test(`[${fx.name}] every cover key matches JS MD5 + byte length of its data`, (t) => {
    const p = parseExport(fx.text);
    const bad = [];
    for (const [k, v] of p.imgs) {
      const meta = parseCoverKey(k);
      const bytes = b64ToBytes(v);
      if (!meta || meta.bytes !== bytes.length || meta.md5 !== md5(bytes)) bad.push(k);
    }
    t.diagnostic(`${p.imgs.size - bad.length}/${p.imgs.size} cover keys verified`);
    assert.deepEqual(bad, []);
  });

  test(`[${fx.name}] dangling cover references are tolerated and preserved`, (t) => {
    const p = parseExport(fx.text);
    const dangling = p.entries.filter((e) => typeof e.obj.img === 'string' && e.obj.img.startsWith('local:') && !p.imgs.has(e.obj.img));
    t.diagnostic(`${dangling.length} entries reference covers missing from imgs`);
    const plan = planImport(emptyLibrary(), new Set(), fx.text, 'replace');
    assert.equal(plan.summary.missingCovers.length, dangling.length);
    for (const d of dangling) assert.equal(plan.lib.entries.get(d.id).img, d.obj.img);
  });

  test(`[${fx.name}] import keeps every entry byte for byte and every referenced cover`, async () => {
    const store = new Store(new MemoryArea()); // MemoryArea sorts object keys like Chrome does
    const plan = planImport(await store.loadLibrary(), new Set(await store.coverKeys()), fx.text, 'replace');
    await store.saveLibrary(plan.lib);
    await store.putCovers(plan.covers);
    assert.ok(await storeContent(store) === mangapinContent(fx.text));
  });

  test(`[${fx.name}] backup -> import on a fresh device restores the same library and covers`, async () => {
    const a = new Store(new MemoryArea()), b = new Store(new MemoryArea());
    const plan = planImport(emptyLibrary(), new Set(), fx.text, 'replace', 1000);
    await a.saveLibrary(plan.lib); await a.putCovers(plan.covers);
    const lib = await a.loadLibrary();
    setProgress(lib, lib.order[0], 999, { now: 2000 }); // edit times and reading travel with it
    await a.saveLibrary(lib);
    const covers = await a.getCovers(await a.coverKeys());
    const backup = exportBackup(await a.loadLibrary(), (k) => covers.get(k), 3000);
    const restore = planImport(await b.loadLibrary(), new Set(), backup, 'replace', 4000);
    await b.saveLibrary(restore.lib); await b.putCovers(restore.covers);
    assert.equal(await storeContent(b), await storeContent(a));
    const la = await a.loadLibrary(), lb = await b.loadLibrary();
    for (const id of la.order) {
      const { rs, ...rest } = metaOf(lb.entries.get(id), lb.meta.get(id)); // the restore marks every entry restored
      const { rs: rsA, ...restA } = metaOf(la.entries.get(id), la.meta.get(id));
      assert.equal(canonical(rest), canonical(restA));
    }
  });

  test(`[${fx.name}] merge-import of the same file into itself changes nothing`, async () => {
    const store = new Store(new MemoryArea());
    const first = planImport(await store.loadLibrary(), new Set(), fx.text, 'replace');
    await store.saveLibrary(first.lib);
    await store.putCovers(first.covers);
    const before = await storeContent(store);
    const again = planImport(await store.loadLibrary(), new Set(await store.coverKeys()), fx.text, 'merge');
    assert.equal(again.summary.added.length, 0);
    assert.equal(again.summary.updated.length, 0);
    assert.equal(again.covers.size, 0);
    await store.saveLibrary(again.lib);
    assert.equal(await storeContent(store), before);
  });
}
