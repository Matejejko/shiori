import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChapters, dueEntries } from '../src/lib/releases.js';
import { emptyLibrary, addEntry, isUnread } from '../src/lib/library.js';
import { trackVisit, genericChapter } from '../src/lib/tracker.js';

const E = () => ({ siteId: 'arena', slug: 'a-portrait-of-pride', name: 'A Portrait of Pride', latest: { chap: 10, ts: 100, cycle: 2 }, progress: { chap: 8, ts: 90 }, cLang: 'en', folder: 1, tags: [], ts: 100, createTs: 1, id: 'AAAAAAAAAA' });

test('applyChapters: new chapter bumps latest, sets next = first unread, keeps unknown latest fields', () => {
  const out = applyChapters(E(), [{ chap: 9 }, { chap: 10 }, { chap: 11, slug: 'x-11', id: 77 }, { chap: 8.5 }], 500);
  assert.deepEqual(out.latest, { chap: 11, ts: 500, cycle: 2 });
  assert.deepEqual(out.next, { chap: 8.5, ts: 500 });
  assert.equal(out.ts, 500);
  assert.deepEqual(Object.keys(out), ['siteId', 'slug', 'name', 'next', 'latest', 'progress', 'cLang', 'folder', 'tags', 'ts', 'createTs', 'id']);
  assert.ok(isUnread(out));
});

test('applyChapters: nothing new -> null (no ts bump, nothing to sync)', () => {
  const e = { ...E(), next: { chap: 9, ts: 50 } };
  assert.equal(applyChapters(e, [{ chap: 9 }, { chap: 10 }], 500), null);
  assert.equal(applyChapters(e, [], 500), null);
  assert.equal(applyChapters(e, [{ chap: NaN }], 500), null);
});

test('applyChapters never lowers latest (a site that hides old chapters)', () => {
  const out = applyChapters(E(), [{ chap: 3 }, { chap: 4 }], 500);
  assert.equal(out, null);
});

test('dueEntries: only release folder, only known sites, only stale', () => {
  const lib = emptyLibrary();
  addEntry(lib, E());
  addEntry(lib, { ...E(), id: 'BBBBBBBBBB', folder: 2 });
  addEntry(lib, { ...E(), id: 'CCCCCCCCCC', siteId: 'www.webtoon.xyz' });
  addEntry(lib, { ...E(), id: 'DDDDDDDDDD' });
  const now = 10 * 3600e3;
  const due = dueEntries(lib, { folder: 1, checked: { DDDDDDDDDD: now - 3600e3 }, now });
  assert.deepEqual(due.map((e) => e.id), ['AAAAAAAAAA']);
});

test('tracking: forward only, latest follows when reading past it', () => {
  const lib = emptyLibrary();
  addEntry(lib, E());
  assert.equal(trackVisit(lib, 'https://arenascan.com/a-portrait-of-pride-chapter-12/', 1000), 'AAAAAAAAAA');
  const e = lib.entries.get('AAAAAAAAAA');
  assert.equal(e.progress.chap, 12);
  assert.equal(e.latest.chap, 12);
  assert.equal(e.latest.cycle, 2);
  assert.ok(e.ts >= e.progress.ts && e.ts >= e.latest.ts);
  assert.equal(trackVisit(lib, 'https://arenascan.com/a-portrait-of-pride-chapter-5/', 2000), null);
  assert.equal(trackVisit(lib, 'https://arenascan.com/manga/a-portrait-of-pride/', 3000), null);
  assert.equal(trackVisit(lib, 'https://arenascan.com/other-series-chapter-50/', 3000), null);
  assert.equal(lib.entries.get('AAAAAAAAAA').progress.chap, 12);
});

test('tracking: generic site entries match by stored url or slug', () => {
  const lib = emptyLibrary();
  addEntry(lib, { siteId: 'www.webtoon.xyz', slug: 'tower-of-god', url: 'https://www.webtoon.xyz/read/tower-of-god/', name: 'ToG', cLang: 'en', folder: 1, tags: [], ts: 1, createTs: 1, id: 'GGGGGGGGGG' });
  addEntry(lib, { siteId: 'my.mangapin.com', slug: 'some-thing', name: 'X', cLang: 'en', folder: 1, tags: [], ts: 1, createTs: 1, id: 'HHHHHHHHHH' });
  assert.equal(trackVisit(lib, 'https://www.webtoon.xyz/read/tower-of-god/chapter-600/', 10), 'GGGGGGGGGG');
  assert.equal(lib.entries.get('GGGGGGGGGG').progress.chap, 600);
  assert.equal(trackVisit(lib, 'https://my.mangapin.com/some-thing/chapter-10-5', 10), 'HHHHHHHHHH');
  assert.equal(lib.entries.get('HHHHHHHHHH').progress.chap, 10.5);
  assert.equal(trackVisit(lib, 'https://www.webtoon.xyz/read/other/chapter-3/', 11), null);
});

test('genericChapter parses common chapter path forms', () => {
  assert.equal(genericChapter('/manga/x/chapter-10/'), 10);
  assert.equal(genericChapter('/x-chapter-10-5/'), 10.5);
  assert.equal(genericChapter('/read/x/ch-7'), 7);
  assert.equal(genericChapter('/series/x/episode_12'), 12);
  assert.equal(genericChapter('/series/x/'), null);
});

test('a newer latest chapter does not keep the old chapter\'s link fields', async () => {
  const { applyChapters } = await import('../src/lib/releases.js');
  const e = { siteId: 'arena', slug: 's', name: 'n', latest: { chap: 10, slug: 'c-10', id: '99', cycle: 2, ts: 1 }, progress: { chap: 9, ts: 1 }, folder: 1, ts: 1, id: 'AAAAAAAAAA' };
  const out = applyChapters(e, [{ chap: 12, slug: 'c-12' }, { chap: 11, slug: 'c-11' }], 1000);
  assert.deepEqual(out.latest, { cycle: 2, chap: 12, ts: 1000 });
});
