// Regression tests for the bugs found in the fresh-eyes review (each one reproduced first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, exportFixtures, storeContent, mangapinContent } from './helpers.mjs';
import { Store, MemoryArea } from '../src/lib/store.js';
import { WebDav } from '../src/lib/webdav.js';
import { syncOnce } from '../src/lib/sync.js';
import { planImport, setProgress, deleteEntry, emptyLibrary, addEntry, formPatch } from '../src/lib/library.js';
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
  assert.equal(await storeContent(a), mangapinContent(text));
  await syncOnce({ store: a, dav: dav() });
  await syncOnce({ store: b, dav: dav() });
  assert.equal(await storeContent(a), mangapinContent(text));
  assert.equal(await storeContent(b), mangapinContent(text));
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
  const e = { name: 'Name ', tags: ['Murim', 'Action'], folder: 1 };
  const shown = { name: 'Name', tags: ['Action', 'Murim'], folder: 1 };
  assert.deepEqual(formPatch(e, shown, { ...shown }), {});
  assert.deepEqual(formPatch(e, shown, { ...shown, tags: ['Action', 'Murim', 'Isekai'] }), { tags: ['Murim', 'Action', 'Isekai'] });
  assert.deepEqual(formPatch(e, shown, { ...shown, tags: ['Murim'] }), { tags: ['Murim'] });
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


test('a real page with Cloudflare\'s normal script is not mistaken for a challenge', () => {
  assert.equal(isBlockedPage(readFileSync(join(FIXTURES, 'sites/comix-chapter.html'), 'utf8')), false);
});

test('the app token is never sent over plain http to another machine', () => {
  assert.throws(() => new WebDav({ url: 'http://192.168.0.101/remote.php/webdav/', user: 'u', token: 't' }), /https/);
  assert.ok(new WebDav({ url: 'http://127.0.0.1:9200/remote.php/webdav/', user: 'u', token: 't' }));
});

test('built-in folder names; your own folder names win', async () => {
  const { labelName } = await import('../src/ui/dom.js');
  assert.equal(labelName(null, 'folder', 2), 'Hiatus');
  assert.equal(labelName({ folder: { 2: { name: 'On break', ts: 1 } } }, 'folder', 2), 'On break');
  assert.equal(labelName({ folder: { 2: { name: '', ts: 1 } } }, 'folder', 2), 'Hiatus'); // removed label -> default again
  assert.equal(labelName(null, 'type', 2), 'Novel');
});

test('tags are names: every genre a site lists is kept, cleaned up, one spelling per tag', async () => {
  const { normalizeTags } = await import('../src/lib/labels.js');
  const { MANGAPIN_TAGS } = await import('../src/lib/mangapin.js');
  assert.deepEqual(
    normalizeTags(['Action', ' fantasy ', 'Slice of Life', 'shônen', 'Tower Climbing', 'ACTION', 'acción', 'sci-fi', 'Regression', 'love', '', '42', 60]),
    ['Action', 'Fantasy', 'Slice of Life', 'Shounen', 'Tower Climbing', 'Science Fiction', 'Regression', 'Love']); // numbers are not tags inside Shiori
  assert.equal(MANGAPIN_TAGS[20], '4 Koma'); assert.equal(MANGAPIN_TAGS[30], 'Self Published');
});

test('data from before format 2 (MangaPin tag numbers) is upgraded once, by version, in storage and from the server', async () => {
  const { entryFromMangaPin } = await import('../src/lib/mangapin-import.js');
  const { fromDoc, toDoc } = await import('../src/lib/sync.js');
  const e = { siteId: 'arena', slug: 's', name: 'n', cLang: 'en', folder: 1, tags: [81, 60, 999], ts: 1, createTs: 1, id: 'OldTagsAA1' };
  assert.deepEqual(entryFromMangaPin(e).tags, ['Fantasy', 'Action', 'Tag 999']);
  assert.deepEqual(Object.keys(entryFromMangaPin(e)), Object.keys(e)); // field order kept
  // storage without a version: upgraded when read, stored as version 2 by the next save
  const store = new Store(new MemoryArea());
  await store.area.set({ 'e:OldTagsAA1': JSON.stringify(e), lib: { order: ['OldTagsAA1'], meta: {}, tombs: {}, labels: { folder: {}, tag: { 999: { name: 'Re-read later', ts: 1 } } } } });
  const lib = await store.loadLibrary();
  assert.deepEqual(lib.entries.get('OldTagsAA1').tags, ['Fantasy', 'Action', 'Re-read later']); // the name you gave a tag number wins
  assert.deepEqual(lib.labels, { folder: {} });
  await store.saveLibrary(lib);
  assert.equal((await store.area.get('lib')).lib.v, 2);
  assert.deepEqual(JSON.parse((await store.area.get('e:OldTagsAA1'))['e:OldTagsAA1']).tags, ['Fantasy', 'Action', 'Re-read later']);
  // server: a format-1 library.json is upgraded; a format-2 one is read exactly as written
  const doc = fromDoc(JSON.stringify({ format: 'shiori-library', version: 1, entries: [e], labels: { folder: {}, type: {}, tag: {} } }));
  assert.deepEqual(doc.entries.get('OldTagsAA1').tags, ['Fantasy', 'Action', 'Tag 999']);
  assert.equal(JSON.parse(toDoc(doc)).version, 3);
  const v2 = { ...e, tags: ['fantasy', 'Action'] }; // format 2 is not re-interpreted, not even cleaned up again
  assert.deepEqual(fromDoc(JSON.stringify({ format: 'shiori-library', version: 2, entries: [v2] })).entries.get('OldTagsAA1').tags, ['fantasy', 'Action']);
});

test('reading before pinning: chapter and series pages map to one series; forward only; max 100, 30 days', async () => {
  const { noteSeen, seriesOf, seenKey } = await import('../src/lib/tracker.js');
  const keyOf = (u) => { const s = seriesOf(u); return seenKey(s.siteId, s.slug); };
  // chapter page and series page of the same series give the same key
  assert.equal(keyOf('https://arenascan.com/a-portrait-of-pride-chapter-23/'), keyOf('https://arenascan.com/manga/a-portrait-of-pride/'));
  assert.equal(keyOf('https://en-thunderscans.com/kaiju-chapter-5/'), keyOf('https://en-thunderscans.com/comics/0086250808-kaiju/'));
  assert.equal(keyOf('https://comix.to/title/1j7n-x/9866083-chapter-68'), keyOf('https://comix.to/title/1j7n-x'));
  assert.equal(keyOf('https://www.webtoon.xyz/read/tower-of-god/chapter-600/'), keyOf('https://www.webtoon.xyz/read/tower-of-god/'));
  const seen = {};
  assert.equal(noteSeen(seen, 'https://arenascan.com/a-portrait-of-pride-chapter-23/', 1), true);
  assert.equal(noteSeen(seen, 'https://arenascan.com/a-portrait-of-pride-chapter-9/', 2), false); // going back
  assert.equal(noteSeen(seen, 'https://arenascan.com/manga/a-portrait-of-pride/', 3), false); // series page: no chapter
  assert.deepEqual(seen[keyOf('https://arenascan.com/manga/a-portrait-of-pride/')], { chap: 23, slug: 'a-portrait-of-pride-chapter-23', ts: 1 });
  assert.equal(noteSeen(seen, 'https://www.webtoon.xyz/read/tower-of-god/chapter-600/', 4), true);
  assert.equal(seen[keyOf('https://www.webtoon.xyz/read/tower-of-god/')].chap, 600);
  for (let i = 0; i < 300; i++) noteSeen(seen, `https://arenascan.com/s${i}-chapter-1/`, 10 + i);
  assert.equal(Object.keys(seen).length, 100);
  // reads you never pinned are forgotten after 30 days
  const { seenFor } = await import('../src/lib/tracker.js');
  const day = 86400e3;
  const old = {};
  noteSeen(old, 'https://arenascan.com/a-portrait-of-pride-chapter-23/', 0);
  assert.equal(seenFor(old, 'arena', 'a-portrait-of-pride', 29 * day).chap, 23);
  assert.equal(seenFor(old, 'arena', 'a-portrait-of-pride', 31 * day), null);
  noteSeen(old, 'https://arenascan.com/other-chapter-1/', 31 * day);
  assert.deepEqual(Object.keys(old), ['arena|other']);
});

test('stats: chapters (pinned and with recent unpinned reads), folders, waiting, tops', async () => {
  const { computeStats, MIN_PER_CHAPTER } = await import('../src/lib/stats.js');
  const now = Date.UTC(2026, 10, 25), day = 86400e3;
  const e = (o) => ({ siteId: 'comix', slug: 's', name: 'n', folder: 1, tags: [], ts: 1, createTs: now - 90 * day, id: 'x', ...o });
  const entries = [
    e({ name: 'A', progress: { chap: 120.5, ts: now - day }, latest: { chap: 125, ts: 1 }, tags: ['Fantasy', 'Action'], score: 8 }),
    e({ name: 'B', progress: { chap: 30, ts: now - 30 * day }, latest: { chap: 30, ts: 1 }, folder: 4, tags: ['Fantasy'], endTs: now - day, siteId: 'asura' }),
    e({ name: 'C', folder: 3, latest: { chap: 10, ts: 1 }, createTs: now - 2 * day, score: 6 }),
  ];
  const seen = { 'arena|x': { chap: 23, ts: now - day }, 'arena|old': { chap: 50, ts: now - 40 * day } };
  const s = computeStats(entries, seen, now);
  assert.equal(s.chapters, 150); // 120 + 30 (a half chapter is not a finished chapter)
  assert.equal(s.chaptersAll, 173); // + 23 read before pinning; the 40-day-old one has expired
  assert.equal(s.unpinnedSeries, 1);
  assert.equal(s.hours, (150 * MIN_PER_CHAPTER) / 60);
  assert.deepEqual([...s.folders], [[1, 1], [4, 1], [3, 1]]);
  assert.equal(s.waiting, 4.5);
  assert.equal(s.withNew, 1);
  assert.equal(s.notStarted, 1);
  assert.equal(s.activeWeek, 1);
  assert.equal(s.added30, 1);
  assert.equal(s.finishedYear, 1);
  assert.equal(s.avgScore, 7);
  assert.deepEqual(s.topSites, [['comix', 120], ['asura', 30]]);
  assert.deepEqual(s.topTags[0], ['Fantasy', 2]);
  assert.deepEqual(s.longest, { name: 'A', chap: 120.5 });
});

test('MangaPin content types have names (no type = comic)', async () => {
  const { labelName } = await import('../src/ui/dom.js');
  assert.equal(labelName(null, 'type', 1), 'Comic');
  assert.equal(labelName(null, 'type', 2), 'Novel');
});

test('importing a series you already have under another id replaces it, never duplicates (both modes)', async () => {
  const now = Date.now();
  const ent = (id, chap, ts) => ({ siteId: 'arena', slug: 'xyz', name: 'XYZ', progress: { chap, slug: `xyz-chapter-${chap}`, ts }, cLang: 'en', folder: 1, tags: [], ts, createTs: 1, id });
  for (const mode of ['merge', 'replace']) {
    const store = new Store(new MemoryArea());
    await importInto(store, JSON.stringify({ version: 1, entries: [ent('LocalXyz01', 12, now - 1000)], imgs: {} }), 'replace', now - 1000);
    const s = await importInto(store, JSON.stringify({ version: 1, entries: [ent('FileXyz002', 22, now - 500)], imgs: {} }), mode, now);
    const lib = await store.loadLibrary();
    assert.equal(lib.entries.size, 1, mode);
    const [e] = lib.entries.values();
    assert.equal(e.id, 'FileXyz002', mode); // smallest id survives, same on every device
    assert.equal(e.progress.chap, 22, mode);
    assert.equal(s.added.length, 0, mode);
    assert.equal(s.updated.length, 1, mode);
    assert.equal(s.removed.length, 0, mode);
    assert.deepEqual(lib.order, ['FileXyz002'], mode);
  }
});

test('a device whose clock is far off the server refuses to sync instead of winning every conflict', async () => {
  const s = fakeDav({ clock: () => Date.now() - 3 * 3600e3 }); // server says it is 3 h earlier
  const dav = () => new WebDav({ url: s.root, user: s.user, token: s.token, fetch: s.fetch });
  const good = new Store(new MemoryArea());
  await importInto(good, fixture, 'replace', Date.now() - 4 * 3600e3);
  await syncOnce({ store: good, dav: dav(), now: () => Date.now() - 3 * 3600e3 }); // first write: no clock to compare yet
  const ahead = new Store(new MemoryArea());
  await assert.rejects(syncOnce({ store: ahead, dav: dav() }), /clock is 180 min ahead/);
  await syncOnce({ store: good, dav: dav(), now: () => Date.now() - 3 * 3600e3 + 60e3 }); // a minute off is fine
});

test('server snapshots: one per day, the newest 14 are kept', async () => {
  let clock = Date.UTC(2026, 0, 1, 12);
  const now = () => clock;
  const s = fakeDav({ clock: now });
  const dav = new WebDav({ url: s.root, user: s.user, token: s.token, fetch: s.fetch });
  const store = new Store(new MemoryArea());
  await importInto(store, fixture, 'replace', clock);
  await syncOnce({ store, dav, now });
  for (let day = 0; day < 20; day++) {
    clock += 86400e3;
    const lib = await store.loadLibrary();
    setProgress(lib, lib.order[0], 100 + day, { now: clock });
    await store.saveLibrary(lib);
    await syncOnce({ store, dav, now });
  }
  const names = [...s.files.keys()].filter((p) => p.includes('/backups/')).map((p) => p.split('/').pop()).sort();
  assert.equal(names.length, 14);
  assert.equal(names.at(-1), `library-${new Date(clock).toISOString().slice(0, 10)}.json`);
});

test('deleting a series drops its cover locally, unless another series uses it', async () => {
  const store = new Store(new MemoryArea());
  await importInto(store, fixture, 'replace', Date.now());
  const lib = await store.loadLibrary();
  const byImg = new Map();
  for (const e of lib.entries.values()) if (typeof e.img === 'string') byImg.set(e.img, [...(byImg.get(e.img) || []), e.id]);
  const keys = new Set(await store.coverKeys());
  const [img, [id]] = [...byImg].find(([k, ids]) => ids.length === 1 && keys.has(k));
  deleteEntry(lib, id);
  await store.saveLibrary(lib);
  const after = new Set(await store.coverKeys());
  assert.equal(after.has(img), false);
  assert.equal(after.size, keys.size - 1);
  assert.equal(await store.getCover(img), undefined);
});

test('moving a series to another site keeps what is yours, drops the dead site, and syncs as one series', async () => {
  const { moveEntry } = await import('../src/lib/library.js');
  const dav = server();
  const a = new Store(new MemoryArea()), b = new Store(new MemoryArea());
  const lib = emptyLibrary();
  addEntry(lib, { siteId: 'asura', slug: 'solo-max-b60d532c', name: 'Solo Max', img: 'local:3:00000000000000000000000000000000.webp', latest: { chap: 120, slug: 'c-120', ts: 5 }, next: { chap: 81, slug: 'c-81', ts: 5 }, progress: { chap: 80, slug: 'chapter-80', ts: 4 }, cLang: 'en', folder: 4, tags: ['Manhwa', 'Donghua'], score: 9, ts: 6, createTs: 1, id: 'OldOldOld1' });
  await a.saveLibrary(lib);
  await syncOnce({ store: a, dav: dav() }); await syncOnce({ store: b, dav: dav() });

  const la = await a.loadLibrary();
  const id = moveEntry(la, 'OldOldOld1', { siteId: 'vortex', slug: 'solo-max', url: 'https://vortexscans.org/series/solo-max' }, 1000);
  await a.saveLibrary(la);
  const e = la.entries.get(id);
  assert.deepEqual([e.siteId, e.slug, e.name, e.folder, e.tags, e.score, e.progress.chap, e.createTs, e.img], ['vortex', 'solo-max', 'Solo Max', 4, ['Manhwa', 'Donghua'], 9, 80, 1, 'local:3:00000000000000000000000000000000.webp']);
  assert.equal(e.latest, undefined); assert.equal(e.next, undefined); assert.equal(e.progress.slug, undefined);
  assert.equal(la.entries.has('OldOldOld1'), false);
  assert.equal(la.order[0], id);

  // device b still on the old site: reads there after the move, then syncs -> one series, on the new site
  const lb = await b.loadLibrary(); setProgress(lb, 'OldOldOld1', 81, { now: 2000 }); await b.saveLibrary(lb);
  await syncOnce({ store: a, dav: dav() }); await syncOnce({ store: b, dav: dav() }); await syncOnce({ store: a, dav: dav() });
  for (const s of [a, b]) {
    const l = await s.loadLibrary();
    assert.deepEqual([...l.entries.keys()], [id]);
    assert.equal(l.entries.get(id).siteId, 'vortex');
    assert.equal(l.entries.get(id).latest, undefined, 'the dead site\'s latest chapter does not come back');
  }
  assert.throws(() => moveEntry(la, id, { siteId: 'vortex', slug: 'solo-max' }), /already on that site/);
});

test('a bare server address finds the WebDAV folder; a non-WebDAV address explains itself', async () => {
  const { findDavRoot } = await import('../src/lib/webdav.js');
  const s = fakeDav(); // serves https://dav.test/remote.php/webdav/
  const o = { user: s.user, token: s.token, fetch: s.fetch };
  assert.equal(await findDavRoot({ url: 'https://dav.test', ...o }), 'https://dav.test/remote.php/webdav/');
  assert.equal(await findDavRoot({ url: s.root, ...o }), s.root);
  const f405 = async () => new Response('', { status: 405 });
  await assert.rejects(findDavRoot({ url: 'https://x.test/', user: 'u', token: 't', fetch: f405 }), /not a WebDAV folder.*remote\.php\/webdav/);
  await assert.rejects(findDavRoot({ url: 'https://dav.test/', user: s.user, token: 'wrong', fetch: s.fetch }), /check username and app token/);
});

test('reading a series unpinned on one device: pinning it on the other starts at that chapter', async () => {
  const { noteSeen, seenFor } = await import('../src/lib/tracker.js');
  const dav = server();
  const a = new Store(new MemoryArea()), b = new Store(new MemoryArea());
  const la = await a.loadLibrary();
  assert.equal(noteSeen(la.seen, 'https://arenascan.com/e2e-seen-chapter-23/'), true);
  await a.saveLibrary(la);
  await syncOnce({ store: a, dav: dav() }); await syncOnce({ store: b, dav: dav() });
  const lb = await b.loadLibrary();
  assert.equal(seenFor(lb.seen, 'arena', 'e2e-seen').chap, 23);
  // an older install kept it outside the library: it is picked up and then moved in
  const old = new Store(new MemoryArea());
  await old.area.set({ seen: { 'arena|legacy': { chap: 4, ts: Date.now() } } });
  const lo = await old.loadLibrary();
  assert.equal(lo.seen['arena|legacy'].chap, 4);
  await old.saveLibrary(lo);
  assert.equal((await old.area.get('seen')).seen, undefined);
  assert.equal((await old.loadLibrary()).seen['arena|legacy'].chap, 4);
});

test('import audit: folded ids merge, the dry run lists every delete, a re-pinned series stays fresh', async () => {
  const { mergeLibraries } = await import('../src/lib/merge.js');
  const mk = (id, chap, ts, extra = {}) => ({ siteId: 'arena', slug: 'alpha', name: 'Alpha', progress: { chap, ts }, cLang: 'en', folder: 1, tags: [], ts, createTs: 1, id, ...extra });
  const mp = (entries) => JSON.stringify({ version: 1, entries, imgs: {} });
  // 1: the MangaPin copy was folded into the Shiori one; a newer MangaPin export still brings its reading
  let lib = emptyLibrary(); addEntry(lib, mk('Aaaaaaaaaa', 100, 1000));
  lib = planImport(lib, new Set(), mp([mk('MangaPin01', 110, 2000)]), 'merge', 3000, 'mangapin').lib;
  assert.deepEqual([...lib.entries.keys()], ['Aaaaaaaaaa']);
  const again = planImport(lib, new Set(), mp([mk('MangaPin01', 140, 4000)]), 'merge', 5000, 'mangapin');
  assert.deepEqual(again.summary.skippedDeleted, []);
  assert.equal(again.lib.entries.get('Aaaaaaaaaa').progress.chap, 140);
  // 2: a backup's deletes are listed in a merge dry run
  const here = emptyLibrary(); addEntry(here, mk('Bbbbbbbbbb', 5, 1000, { slug: 'beta', name: 'Beta' }));
  const there = structuredClone(here); deleteEntry(there, 'Bbbbbbbbbb', 2000);
  const { exportBackup } = await import('../src/lib/library.js');
  const plan = planImport(here, new Set(), exportBackup(there, () => undefined, 2500), 'merge', 3000, 'shiori');
  assert.deepEqual(plan.summary.removed.map((x) => x.id), ['Bbbbbbbbbb']);
  assert.equal(plan.lib.entries.size, 0);
  // 3: delete at ch50 to start over, pin again at ch3: a stale copy of the deleted id brings nothing back
  const dev = emptyLibrary(); addEntry(dev, mk('Oldoldold1', 50, 1000));
  const stale = structuredClone(dev);
  deleteEntry(dev, 'Oldoldold1', 2000); addEntry(dev, mk('Newnewnew1', 3, 3000));
  const m = mergeLibraries(stale, dev);
  assert.deepEqual([...m.entries.keys()], ['Newnewnew1']);
  assert.equal(m.entries.get('Newnewnew1').progress.chap, 3);
  // 4: entries without a usable slug are each their own series in a replace
  const nos = emptyLibrary();
  for (const id of ['Nnnnnnnnn1', 'Nnnnnnnnn2', 'Nnnnnnnnn3']) addEntry(nos, { siteId: 'kagane', slug: '', name: id, cLang: 'en', folder: 1, tags: [], ts: 1, createTs: 1, id });
  const rep = planImport(nos, new Set(), mp([{ ...nos.entries.get('Nnnnnnnnn1') }]), 'replace', 5000, 'mangapin');
  assert.deepEqual([...rep.lib.entries.keys()], ['Nnnnnnnnn1']);
  assert.deepEqual(rep.summary.removed.map((x) => x.id).sort(), ['Nnnnnnnnn2', 'Nnnnnnnnn3']);
});

test('merge: an empty latest/next is order-free', async () => {
  const { mergeEntry } = await import('../src/lib/merge.js');
  const a = { siteId: 's', slug: 'x', name: 'n', latest: null, folder: 1, ts: 5, id: 'AAAAAAAAAA' };
  const b = { siteId: 's', slug: 'x', name: 'n', folder: 1, ts: 5, id: 'AAAAAAAAAA' };
  assert.equal(JSON.stringify(mergeEntry(a, null, b, null).entry), JSON.stringify(mergeEntry(b, null, a, null).entry));
});

test('the first upload also checks the clock (the server is empty, its 404 still has a Date)', async () => {
  const s = fakeDav({ clock: () => Date.now() - 3 * 3600e3 });
  const dav = new WebDav({ url: s.root, user: s.user, token: s.token, fetch: s.fetch });
  const store = new Store(new MemoryArea());
  await importInto(store, fixture, 'replace', Date.now());
  await assert.rejects(syncOnce({ store, dav }), /clock is 180 min ahead/);
  assert.equal([...s.files.keys()].some((p) => p.endsWith('library.json')), false);
});
