import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportFixtures, realExportPresent } from './helpers.mjs';
import { parseExport, serializeExport, exportFileName, parseCoverKey, coverKeyFor, coverKeyToFile, coverFileToKey, withField } from '../src/lib/mangapin.js';
import { b64ToBytes, bytesToB64 } from '../src/lib/base64.js';
import { md5 } from '../src/lib/md5.js';
import { createHash, randomBytes } from 'node:crypto';
import { Store, MemoryArea } from '../src/lib/store.js';
import { planImport, exportString, emptyLibrary } from '../src/lib/library.js';

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
  assert.equal(exportFileName(new Date(2026, 0, 5, 7, 9)), 'MangaPin202601050709.json');
});

test('withField keeps existing order and inserts new keys in MangaPin order', () => {
  const e = { siteId: 'a', slug: 'b', name: 'n', cLang: 'en', ts: 1, id: 'x' };
  assert.deepEqual(Object.keys(withField(e, 'progress', {})), ['siteId', 'slug', 'name', 'progress', 'cLang', 'ts', 'id']);
  assert.deepEqual(Object.keys(withField(e, 'name', 'z')), Object.keys(e));
  assert.deepEqual(Object.keys(withField(e, 'zzz', 1)), [...Object.keys(e), 'zzz']);
});

test('unknown top-level and entry fields survive, odd files still round-trip', () => {
  const src = JSON.stringify({ version: 1, extra: { b: 1, a: [2] }, entries: [{ id: 'AAAAAAAAAA', siteId: 's', slug: 'x', name: '“q”   </script>', zz: { y: 1, x: 2 }, ts: 5 }], imgs: {}, tail: null });
  const p = parseExport(src);
  assert.equal(p.canonical, true);
  const lib = emptyLibrary();
  const plan = planImport(lib, new Set(), src, 'replace');
  const out = exportString(plan.lib, (k) => p.imgs.get(k));
  assert.equal(out, src);
});

for (const fx of exportFixtures()) {
  test(`[${fx.name}] parses cleanly`, (t) => {
    const p = parseExport(fx.text);
    t.diagnostic(`${p.entries.length} entries, ${p.imgs.size} covers, canonical=${p.canonical}, problems=${p.problems.length}`);
    for (const pr of p.problems.slice(0, 20)) t.diagnostic('problem: ' + pr);
    assert.equal(p.canonical, true, 'file is not plain JSON.stringify output — byte-identical export impossible');
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

  test(`[${fx.name}] imgs key order is first-reference order`, () => {
    const data = JSON.parse(fx.text);
    const order = [];
    for (const e of data.entries) if (e.img in data.imgs && !order.includes(e.img)) order.push(e.img);
    assert.deepEqual(Object.keys(data.imgs).slice(0, order.length), order);
  });

  test(`[${fx.name}] import -> chrome.storage-like store -> export is byte-identical`, async () => {
    const store = new Store(new MemoryArea()); // MemoryArea sorts object keys like Chrome does
    const plan = planImport(await store.loadLibrary(), new Set(await store.coverKeys()), fx.text, 'replace');
    await store.saveLibrary(plan.lib);
    await store.putCovers(plan.covers);
    const lib = await store.loadLibrary();
    const covers = await store.getCovers(await store.coverKeys());
    const out = exportString(lib, (k) => covers.get(k));
    assert.equal(out.length, fx.text.length);
    assert.ok(out === fx.text, 'export differs from the imported file');
  });

  test(`[${fx.name}] merge-import of the same file into itself changes nothing`, async () => {
    const store = new Store(new MemoryArea());
    const first = planImport(await store.loadLibrary(), new Set(), fx.text, 'replace');
    await store.saveLibrary(first.lib);
    await store.putCovers(first.covers);
    const lib = await store.loadLibrary();
    const again = planImport(lib, new Set(await store.coverKeys()), fx.text, 'merge');
    assert.equal(again.summary.added.length, 0);
    assert.equal(again.summary.updated.length, 0);
    assert.equal(again.covers.size, 0);
    const covers = await store.getCovers(await store.coverKeys());
    assert.equal(exportString(again.lib, (k) => covers.get(k)), fx.text);
  });
}

test('serializeExport without a template emits version/entries/imgs', () => {
  const s = serializeExport({ entriesRaw: ['{"id":"a"}'], imgKeys: ['k', 'missing'], imgData: (k) => (k === 'k' ? 'QQ==' : undefined) });
  assert.equal(s, '{"version":1,"entries":[{"id":"a"}],"imgs":{"k":"QQ=="}}');
});
