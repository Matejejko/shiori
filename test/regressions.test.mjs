// Regression tests for the bugs found in the fresh-eyes review (each one reproduced first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, exportFixtures } from './helpers.mjs';
import { Store, MemoryArea } from '../src/lib/store.js';
import { WebDav } from '../src/lib/webdav.js';
import { syncOnce } from '../src/lib/sync.js';
import { planImport, exportString, setProgress, deleteEntry, emptyLibrary, addEntry, formPatch } from '../src/lib/library.js';
import { locate } from '../src/lib/tracker.js';
import { isBlockedPage } from '../src/lib/releases.js';
import { matchUrl } from '../src/lib/adapters.js';
import { fakeDav } from './fakedav.mjs';

const fixture = exportFixtures()[0].text;
const server = () => { const s = fakeDav(); return () => new WebDav({ url: s.root, user: s.user, token: s.token, fetch: s.fetch }); };
async function importInto(store, text, mode, now) {
  const plan = planImport(await store.loadLibrary(), new Set(await store.coverKeys()), text, mode, now);
  await store.putCovers(plan.covers);
  await store.saveLibrary(plan.lib);
  return plan.summary;
}
async function exportOf(store) {
  const lib = await store.loadLibrary();
  const covers = await store.getCovers(await store.coverKeys());
  return exportString(lib, (k) => covers.get(k));
}

test('a second device replace-importing an old export does not revert reading done elsewhere', async () => {
  const dav = server();
  const desktop = new Store(new MemoryArea()), laptop = new Store(new MemoryArea());
  await importInto(desktop, fixture, 'replace', Date.now() - 7 * 86400e3);
  await syncOnce({ store: desktop, dav: dav() });
  // a week of reading on the desktop
  const lib = await desktop.loadLibrary();
  const read = new Map();
  for (const id of lib.order.slice(0, 30)) {
    const c = (lib.entries.get(id).progress?.chap ?? 0) + 5;
    setProgress(lib, id, c); read.set(id, c);
  }
  await desktop.saveLibrary(lib);
  await syncOnce({ store: desktop, dav: dav() });
  // new laptop: "Replace" with the same old export, then sync (the background syncs first;
  // here the laptop has no settings yet, which is the worst case)
  await importInto(laptop, fixture, 'replace');
  await syncOnce({ store: laptop, dav: dav() });
  await syncOnce({ store: desktop, dav: dav() });
  for (const store of [desktop, laptop]) {
    const l = await store.loadLibrary();
    for (const [id, c] of read) assert.equal(l.entries.get(id).progress.chap, c, id);
  }
});

test('replace after pulling the server deletes series that only another device had', async () => {
  const dav = server();
  const a = new Store(new MemoryArea()), b = new Store(new MemoryArea());
  await importInto(a, fixture, 'replace');
  const extra = { siteId: 'arena', slug: 'only-on-a', name: 'Only on A', cLang: 'en', folder: 1, tags: [], ts: Date.now(), createTs: Date.now(), id: 'OnlyOnA123' };
  const la = await a.loadLibrary(); addEntry(la, extra); await a.saveLibrary(la);
  await syncOnce({ store: a, dav: dav() });
  await syncOnce({ store: b, dav: dav() }); // background does this before a replace
  const s = await importInto(b, fixture, 'replace');
  assert.deepEqual(s.removed.map((x) => x.id), ['OnlyOnA123']);
  await syncOnce({ store: b, dav: dav() });
  await syncOnce({ store: a, dav: dav() });
  assert.equal((await a.loadLibrary()).entries.has('OnlyOnA123'), false);
});

test('replace with a reordered export (and fewer covers) survives sync byte-identically', async () => {
  const dav = server();
  const a = new Store(new MemoryArea()), b = new Store(new MemoryArea());
  await importInto(a, fixture, 'replace', 1000);
  await syncOnce({ store: a, dav: dav() });
  // newer export: reversed order, one orphan cover added
  const d = JSON.parse(fixture);
  d.entries.reverse();
  const imgs = {};
  for (const e of d.entries) if (e.img in d.imgs && !(e.img in imgs)) imgs[e.img] = d.imgs[e.img];
  const orphan = Object.keys(d.imgs)[0];
  d.imgs = imgs;
  const text = JSON.stringify(d);
  await importInto(a, text, 'replace', 2000);
  assert.equal(await exportOf(a), text);
  await syncOnce({ store: a, dav: dav() });
  await syncOnce({ store: b, dav: dav() });
  assert.equal(await exportOf(a), text);
  assert.equal(await exportOf(b), text);
  assert.ok(orphan); // (the first cover is still referenced; nothing resurrects)
});

test('merge-import does not resurrect a series deleted here, even with a newer MangaPin ts', async () => {
  const s = new Store(new MemoryArea());
  await importInto(s, fixture, 'replace');
  const lib = await s.loadLibrary();
  const id = lib.order[0];
  deleteEntry(lib, id);
  await s.saveLibrary(lib);
  const d = JSON.parse(fixture);
  d.entries[0].ts = Date.now() + 60e3; // MangaPin bumped it with a release check
  const sum = await importInto(s, JSON.stringify(d), 'merge');
  assert.deepEqual(sum.skippedDeleted.map((x) => x.id), [id]);
  assert.equal((await s.loadLibrary()).entries.has(id), false);
});

test('concurrent cover writes never lose a key from the index', async () => {
  class SlowArea extends MemoryArea {
    async get(k) { await new Promise((r) => setTimeout(r, Math.random() * 3)); return super.get(k); }
    async set(o) { await new Promise((r) => setTimeout(r, Math.random() * 3)); return super.set(o); }
  }
  const s = new Store(new SlowArea());
  await Promise.all(Array.from({ length: 40 }, (_, i) => s.putCovers([[`local:1:${String(i).padStart(32, '0')}.webp`, 'QQ==']])));
  assert.equal((await s.coverKeys()).length, 40);
});

test('editor: an untouched Save is a no-op; tag order is the entry\'s own', () => {
  const e = { name: 'Name ', tags: [7, 3], folder: 1 };
  const shown = { name: 'Name', tags: [3, 7], folder: 1 };
  assert.deepEqual(formPatch(e, shown, { ...shown }), {});
  assert.deepEqual(formPatch(e, shown, { ...shown, tags: [3, 7, 9] }), { tags: [7, 3, 9] });
  assert.deepEqual(formPatch(e, shown, { ...shown, tags: [7] }), { tags: [7] });
  assert.deepEqual(formPatch(e, shown, { ...shown, folder: 2 }), { folder: 2 });
});

test('generic sites: a longer series path is not swallowed by a shorter pinned one', () => {
  const lib = emptyLibrary();
  addEntry(lib, { siteId: 'www.webtoon.xyz', slug: '/read/solo-leveling', name: 'SL', cLang: 'en', folder: 1, tags: [], ts: 1, createTs: 1, id: 'SoloLevel1' });
  addEntry(lib, { siteId: 'mangasite.example', slug: 'tower', name: 'T', cLang: 'en', folder: 1, tags: [], ts: 1, createTs: 1, id: 'TowerTowe1' });
  assert.equal(locate(lib, 'https://www.webtoon.xyz/read/solo-leveling-ragnarok/chapter-60/').entry, null);
  assert.equal(locate(lib, 'https://mangasite.example/manga/tower-of-god/chapter-600').entry, null);
  assert.equal(locate(lib, 'https://www.webtoon.xyz/read/solo-leveling/chapter-60/').match.chap, 60);
  assert.equal(locate(lib, 'https://www.webtoon.xyz/read/solo-leveling-chapter-61/').match.chap, 61);
});

test('thunderscans: a dash-less chapter path resolves against the pinned series', () => {
  const lib = emptyLibrary();
  addEntry(lib, { siteId: 'thunder', slug: '0086250808-kaiju-no-8', name: 'K8', cLang: 'en', folder: 1, tags: [], ts: 1, createTs: 1, id: 'KaijuNo8XX' });
  const { entry, match } = locate(lib, 'https://en-thunderscans.com/0086250808-kaiju-no-8-12/');
  assert.equal(entry && entry.id, 'KaijuNo8XX');
  assert.equal(match.chap, 12);
  assert.equal(matchUrl('https://en-thunderscans.com/0086250808-kaiju-no-8-12/').chap, 12); // integer-only alone
});

test('dry run: "byte-identical" is not claimed for files with duplicate ids', () => {
  const d = JSON.parse(fixture);
  d.entries.push({ ...d.entries[0] });
  assert.equal(planImport(emptyLibrary(), new Set(), JSON.stringify(d), 'replace').summary.exact, false);
  assert.equal(planImport(emptyLibrary(), new Set(), fixture, 'replace').summary.exact, true);
});

test('a real page with Cloudflare\'s normal script is not mistaken for a challenge', () => {
  assert.equal(isBlockedPage(readFileSync(join(FIXTURES, 'sites/comix-chapter.html'), 'utf8')), false);
});

test('the app token is never sent over plain http to another machine', () => {
  assert.throws(() => new WebDav({ url: 'http://192.168.0.101/remote.php/webdav/', user: 'u', token: 't' }), /https/);
  assert.ok(new WebDav({ url: 'http://127.0.0.1:9200/remote.php/webdav/', user: 'u', token: 't' }));
});

test('built-in names for folders and MangaPin tags; your own labels win', async () => {
  const { labelName } = await import('../src/ui/dom.js');
  assert.equal(labelName(null, 'folder', 2), 'Hiatus');
  assert.equal(labelName(null, 'tag', 81), 'Fantasy');
  assert.equal(labelName({ tag: { 81: { name: 'Fantasy!', ts: 1 } } }, 'tag', 81), 'Fantasy!');
  assert.equal(labelName({ tag: { 81: { name: '', ts: 1 } } }, 'tag', 81), 'Fantasy'); // removed label -> default again
  assert.equal(labelName(null, 'tag', 99999), null);
});
