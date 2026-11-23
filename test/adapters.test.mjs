import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, exportFixtures } from './helpers.mjs';
import { parseExport } from '../src/lib/mangapin.js';
import { matchUrl, seriesUrl, chapterUrl, getAdapter, entrySlug, sameSeries, matchChapterForSeries } from '../src/lib/adapters.js';
import { fetchChapters, applyChapters, isBlockedPage } from '../src/lib/releases.js';
import { locate } from '../src/lib/tracker.js';
import { emptyLibrary, addEntry } from '../src/lib/library.js';

const SITES_DIR = join(FIXTURES, 'sites');
const read = (f) => readFileSync(join(SITES_DIR, f), 'utf8');

// ---- URL parsing on real URLs (collected from the live sites, 2026-11-23) -----------------
const REAL = [
  ['https://comix.to/title/1j7n-not-interested-in-dating', { siteId: 'comix', slug: '1j7n-not-interested-in-dating', kind: 'series' }],
  ['https://comix.to/title/939g0-killing-stalking/10506719-chapter-34.1', { siteId: 'comix', slug: '939g0-killing-stalking', kind: 'chapter', chap: 34.1, chapSlug: '10506719-chapter-34.1', cid: '10506719' }],
  ['https://comix.ws/title/1j7n-not-interested-in-dating/9866083-chapter-68', { siteId: 'comix', kind: 'chapter', chap: 68 }],
  ['https://vortexscans.org/series/a-dance-of-swords-in-the-night/chapter-131', { siteId: 'vortex', slug: 'a-dance-of-swords-in-the-night', chap: 131, chapSlug: 'chapter-131' }],
  ['https://vortexscans.org/series/x/chapter-190.5', { chap: 190.5 }],
  ['https://vortexscans.org/series/x/chapter-168-1', { chap: 168.1 }],
  ['https://vortexmanga.com/series/a-space-marine-got-a-status-window', { siteId: 'vortex', kind: 'series' }],
  ['https://en-thunderscans.com/comics/0086250808-i-got-the-weakest-class-dragon-tamer/', { siteId: 'thunder', slug: '0086250808-i-got-the-weakest-class-dragon-tamer', kind: 'series' }],
  ['https://en-thunderscans.com/i-got-the-weakest-class-dragon-tamer-chapter-308/', { siteId: 'thunder', slug: 'i-got-the-weakest-class-dragon-tamer', chap: 308 }],
  ['https://en-thunderscans.com/0086250808-i-got-the-weakest-class-dragon-tamer-chapter-18-2/', { siteId: 'thunder', chap: 18.2 }],
  ['https://asurascans.com/comics/30-years-since-the-prologue-7de80a82/chapter/26', { siteId: 'asura', slug: '30-years-since-the-prologue-7de80a82', chap: 26, chapSlug: '26' }],
  ['https://asuracomic.net/series/solo-max-level-newbie-1a2b3c4d/chapter/12', { siteId: 'asura', chap: 12 }],
  ['https://arenascan.com/a-portrait-of-pride-chapter-22/', { siteId: 'arena', slug: 'a-portrait-of-pride', chap: 22, chapSlug: 'a-portrait-of-pride-chapter-22' }],
  ['https://kingofshojo.com/manga/anyone-can-see-its-a-beast/', { siteId: 'kingofshojo', kind: 'series' }],
  ['https://roliascan.com/read/goblin-corporation/ch23-389521/', { siteId: 'rolia', slug: 'goblin-corporation', chap: 23, cid: '389521', chapSlug: 'ch23-389521' }],
  ['https://ezmanga.org/series/the-kind-intruder/chapter-76', { siteId: 'ezmanga', chap: 76 }],
  ['https://valirscans.org/series/comic/became-a-family-with-the-four-duke-brothers/chapter/49?ref=x', { siteId: 'valir', chap: 49, chapSlug: '49' }],
  ['https://www.mangaread.org/manga/a-i-doctor/chapter-538-6/', { siteId: 'mangareadorg', slug: 'a-i-doctor', chap: 538.6 }],
  ['https://kagane.moe/series/ABC123/reader/XYZ789', { siteId: 'kagane', kind: 'chapter', chap: null }],
  ['https://kagane.org/series/ABC123', { siteId: 'kagane', kind: 'series' }],
];
for (const [url, want] of REAL) {
  test(`matchUrl ${url}`, () => {
    const got = matchUrl(url);
    assert.ok(got, 'no match');
    for (const [k, v] of Object.entries(want)) assert.deepEqual(got[k], v, k);
  });
}

test('unknown hosts and non-series pages', () => {
  assert.equal(matchUrl('https://example.com/manga/x/'), null);
  assert.deepEqual(matchUrl('https://comix.to/browse?q=x'), { siteId: 'comix', slug: null, kind: null });
  assert.equal(matchUrl('not a url'), null);
});

test('MangaPin slug rules: absolute URL slugs and path slugs', () => {
  // legacy host (redirects to the homepage): rebuilt on the current template
  assert.equal(seriesUrl({ siteId: 'asura', slug: 'https://asuracomic.net/series/foo-1a2b3c4d' }), 'https://asurascans.com/comics/foo-1a2b3c4d');
  assert.equal(chapterUrl({ siteId: 'asura', slug: 'x' }, { chap: 3, slug: 'https://asuracomic.net/series/foo-1a2b3c4d/chapter/3' }), 'https://asurascans.com/comics/foo-1a2b3c4d/chapter/3');
  // live mirror: kept as is
  assert.equal(seriesUrl({ siteId: 'comix', slug: 'https://comix.ws/title/ab1-x' }), 'https://comix.ws/title/ab1-x');
  // unknown host for the site: host swapped
  assert.equal(seriesUrl({ siteId: 'comix', slug: 'https://old-comix.example/title/ab1-x' }), 'https://comix.to/title/ab1-x');
  assert.equal(seriesUrl({ siteId: 'arena', slug: '/manga/foo/' }), 'https://arenascan.com/manga/foo/');
  assert.equal(entrySlug({ siteId: 'arena', slug: '/manga/foo/' }), 'foo');
  assert.equal(seriesUrl({ siteId: 'www.webtoon.xyz', slug: '/read/tower-of-god' }), 'https://www.webtoon.xyz/read/tower-of-god/');
  assert.equal(seriesUrl({ siteId: 'my.mangapin.com', slug: 'Qm9vayAx' }), null);
  // Thunderscans: user-facing link drops the rotating id (redirects to the current URL)
  assert.equal(seriesUrl({ siteId: 'thunder', slug: '0086250808-x-y' }), 'https://en-thunderscans.com/comics/0086250808-x-y/');
  assert.equal(seriesUrl({ siteId: 'thunder', slug: '0086250808-x-y' }, { link: true }), 'https://en-thunderscans.com/comics/x-y/');
  assert.ok(sameSeries('asura', 'foo-7de80a82', 'foo-1a2b3c4d'));
  assert.ok(sameSeries('thunder', '0086250808-foo', 'foo'));
  assert.ok(sameSeries('comix', '1j7n-old-title', '1j7n-new-title'));
  assert.ok(!sameSeries('arena', 'foo', 'bar'));
});

test('chapter URLs: built from slug or number, null when the site needs an id we do not have', () => {
  assert.equal(chapterUrl({ siteId: 'comix', slug: 'a1-x' }, { chap: 5, slug: '123-chapter-5' }), 'https://comix.to/title/a1-x/123-chapter-5');
  assert.equal(chapterUrl({ siteId: 'comix', slug: 'a1-x' }, { chap: 5 }), null);
  assert.equal(chapterUrl({ siteId: 'asura', slug: 'x-7de80a82' }, { chap: 10.5 }), 'https://asurascans.com/comics/x-7de80a82/chapter/10.5');
  assert.equal(chapterUrl({ siteId: 'arena', slug: 'x' }, { chap: 10.5 }), 'https://arenascan.com/x-chapter-10-5/');
  assert.equal(chapterUrl({ siteId: 'thunder', slug: '0086250808-x' }, { chap: 3 }), 'https://en-thunderscans.com/x-chapter-3/');
  assert.equal(chapterUrl({ siteId: 'rolia', slug: 'x' }, { chap: 3 }), null);
  assert.equal(chapterUrl({ siteId: 'www.webtoon.xyz', slug: '/read/x' }, { chap: 3, slug: '/read/x/chapter-3/' }), 'https://www.webtoon.xyz/read/x/chapter-3/');
});

// ---- Acceptance: every entry of every export builds URLs that parse back -------------------
for (const fx of exportFixtures()) {
  test(`[${fx.name}] every entry: series/chapter URLs build and parse back to siteId/slug/chap`, (t) => {
    const { entries } = parseExport(fx.text);
    const lib = emptyLibrary();
    for (const { obj } of entries) addEntry(lib, obj);
    const fail = [];
    const stats = { series: 0, chapters: 0, noSeries: [], noChapter: {} };
    const note = (why, e) => { (stats.noChapter[why] ||= []).push(`${e.siteId}:${e.name}`); };
    for (const { obj: e } of entries) {
      const a = getAdapter(e.siteId);
      const url = seriesUrl(e);
      if (!url) { stats.noSeries.push(`${e.siteId}:${e.name}${e.url ? ' (has url)' : ''}`); }
      else {
        stats.series++;
        if (a) {
          const m = matchUrl(url);
          if (!m || m.siteId !== e.siteId || m.kind !== 'series' || m.slug !== entrySlug(e)) fail.push(`series ${e.siteId}/${e.slug} -> ${url} -> ${JSON.stringify(m)}`);
        } else {
          const { entry } = locate(lib, url);
          if (!entry || entry.id !== e.id) fail.push(`generic series ${e.siteId}${e.slug} -> ${url} not located`);
        }
      }
      if (e.url && a) {
        const m = matchUrl(e.url);
        if (!m || m.siteId !== e.siteId || !sameSeries(e.siteId, m.slug, entrySlug(e))) fail.push(`stored url ${e.url} does not parse to ${e.siteId}/${e.slug}`);
      }
      for (const field of ['progress', 'next']) {
        const ch = e[field];
        if (!ch || typeof ch.chap !== 'number') continue;
        const cu = chapterUrl(e, ch);
        if (!cu) {
          note(!a ? 'generic site without chapter path' : e.siteId === 'kagane' ? 'kagane (opaque chapter ids)' : `${e.siteId}: needs chapter slug/id, entry has only the number`, e);
          continue;
        }
        stats.chapters++;
        if (a) {
          const m = matchUrl(cu);
          if (e.siteId === 'kagane') { if (!m || m.kind !== 'chapter' || m.chapSlug !== ch.slug) fail.push(`kagane ${cu}`); continue; }
          if (!m || m.siteId !== e.siteId || m.kind !== 'chapter' || !sameSeries(e.siteId, m.slug, entrySlug(e)) || m.chap !== ch.chap || (ch.slug && m.chapSlug !== ch.slug)) {
            fail.push(`${field} ${e.siteId}/${e.slug} ch ${ch.chap} (${ch.slug ?? '-'}) -> ${cu} -> ${JSON.stringify(m)}`);
          }
        } else {
          const { entry, match } = locate(lib, cu);
          if (!entry || entry.id !== e.id || match.chap !== ch.chap) fail.push(`generic ${field} ${cu} -> ${JSON.stringify(match)}`);
        }
      }
    }
    t.diagnostic(`${entries.length} entries: ${stats.series} series URLs and ${stats.chapters} chapter URLs round-tripped`);
    if (stats.noSeries.length) t.diagnostic(`no series URL (${stats.noSeries.length}): ${stats.noSeries.join(', ')}`);
    for (const [why, list] of Object.entries(stats.noChapter)) t.diagnostic(`no chapter URL — ${why}: ${list.length}`);
    assert.deepEqual(fail, []);
    // only source-less entries may lack a series URL
    for (const s of stats.noSeries) assert.match(s, /^my\.mangapin\.com:|\(has url\)$/, s);
  });
}

// ---- Chapter lists from real (saved) responses --------------------------------------------
const ROUTES = {
  'comix.to/title/1j7n-not-interested-in-dating': 'comix-series.html',
  'api.vortexscans.org/api/post?postSlug=a-space-marine-got-a-status-window': 'vortex-post-api.json',
  'api.vortexscans.org/api/chapters?postId=668&skip=0&take=999&order=desc': 'vortex-chapters-api.json',
  'en-thunderscans.com/comics/i-got-the-weakest-class-dragon-tamer/': 'thunder-series.html',
  'api.asurascans.com/api/series/a-wimps-strategy-guide-to-conquer-the-tower/chapters': 'asura-chapters-api.json',
  'arenascan.com/manga/a-portrait-of-pride/': 'arena-series.html',
  'kingofshojo.com/manga/anyone-can-see-its-a-beast/': 'kingofshojo-series.html',
  'roliascan.com/manga/goblin-corporation/': 'rolia-series.html',
  'roliascan.com/auth/manga-chapters?manga_id=275456&offset=0&limit=500&order=DESC': 'rolia-chapters-api.json',
  'vapi.ezmanga.org/api/v1/series/the-kind-intruder/chapters?page=1&perPage=100&sort=desc': 'ezmanga-chapters-api.json',
  'valirscans.org/series/comic/became-a-family-with-the-four-duke-brothers': 'valir-series.html',
  'www.mangaread.org/manga/a-i-doctor/': 'mangareadorg-series.html',
  'www.mangaread.org/manga/a-i-doctor/ajax/chapters/': 'mangareadorg-ajax-chapters.html',
};
function fakeFetch(seen = []) {
  return async (req) => {
    const k = req.url.replace(/^https:\/\//, '');
    seen.push(`${req.method || 'GET'} ${k}`);
    if (!ROUTES[k]) throw new Error('unexpected request ' + req.url);
    return read(ROUTES[k]);
  };
}

const LISTS = [
  // siteId, slug, expected count, min, max, complete, sample {chap, slug}
  ['comix', '1j7n-not-interested-in-dating', 2, 1, 68, false, { chap: 68, slug: '9866083-chapter-68' }],
  ['vortex', 'a-space-marine-got-a-status-window', 19, 1, 19, true, { chap: 19, slug: 'chapter-19' }],
  ['thunder', '0086250808-i-got-the-weakest-class-dragon-tamer', 124, 1, 308, true, { chap: 308, slug: 'i-got-the-weakest-class-dragon-tamer-chapter-308' }],
  ['asura', 'a-wimps-strategy-guide-to-conquer-the-tower-7de80a82', 56, 1, 56, true, { chap: 56, slug: '56' }],
  ['arena', 'a-portrait-of-pride', 23, 0, 22, true, { chap: 22, slug: 'a-portrait-of-pride-chapter-22' }],
  ['kingofshojo', 'anyone-can-see-its-a-beast', 74, 1, 74, true, { chap: 74, slug: 'anyone-can-see-its-a-beast-chapter-74' }],
  ['rolia', 'goblin-corporation', 23, 1, 23, true, { chap: 23, slug: 'ch23-389521' }],
  ['ezmanga', 'the-kind-intruder', 77, 0, 76, true, { chap: 76, slug: 'chapter-76' }],
  ['valir', 'became-a-family-with-the-four-duke-brothers', 49, 1, 49, true, { chap: 49, slug: '49' }],
  ['mangareadorg', 'a-i-doctor', 140, 1, 189, true, { chap: 189, slug: 'chapter-189' }],
];
for (const [siteId, slug, n, min, max, complete, sample] of LISTS) {
  test(`chapter list: ${siteId} (saved live response)`, async () => {
    const r = await fetchChapters({ siteId, slug }, fakeFetch());
    const nums = r.chapters.map((c) => c.chap).sort((a, b) => a - b);
    assert.equal(nums.length, n);
    assert.equal(nums[0], min);
    assert.equal(nums.at(-1), max);
    assert.equal(r.complete, complete);
    const s = r.chapters.find((c) => c.chap === sample.chap);
    assert.equal(s.slug, sample.slug);
    // every extracted chapter builds a URL that parses back to the same chapter (for root-level
    // MangaThemesia paths like "/{title}-22/" only when the series is known, as tracking does)
    for (const c of r.chapters) {
      const u = chapterUrl({ siteId, slug }, c);
      if (!u) continue;
      const m = matchUrl(u);
      const chap = m && m.kind === 'chapter' && sameSeries(siteId, m.slug, slug) ? m.chap : matchChapterForSeries(u, siteId, slug)?.chap;
      assert.equal(chap, c.chap, u);
    }
  });
}

test('rolia uses rawId directly when the export has it (one request instead of two)', async () => {
  const seen = [];
  const r = await fetchChapters({ siteId: 'rolia', slug: 'goblin-corporation', rawId: '275456' }, fakeFetch(seen));
  assert.equal(r.chapters.length, 23);
  assert.deepEqual(seen, ['GET roliascan.com/auth/manga-chapters?manga_id=275456&offset=0&limit=500&order=DESC']);
});

test('madara falls back to POST …/ajax/chapters/ when the page has no chapter list', async () => {
  const seen = [];
  const routes = { ...ROUTES };
  const fetchText = async (req) => {
    const k = req.url.replace(/^https:\/\//, '');
    seen.push(`${req.method || 'GET'} ${k}`);
    return k.endsWith('/ajax/chapters/') ? read(routes[k]) : '<html><body class="manga-page"><div id="manga-chapters-holder"></div></body></html>';
  };
  const r = await fetchChapters({ siteId: 'mangareadorg', slug: 'a-i-doctor' }, fetchText);
  assert.ok(r.chapters.length > 100);
  assert.deepEqual(seen, ['GET www.mangaread.org/manga/a-i-doctor/', 'POST www.mangaread.org/manga/a-i-doctor/ajax/chapters/']);
});

test('comix partial list: latest is updated, next only if it is the very next chapter', async () => {
  const { chapters, complete } = await fetchChapters({ siteId: 'comix', slug: '1j7n-not-interested-in-dating' }, fakeFetch());
  const base = { siteId: 'comix', slug: '1j7n-not-interested-in-dating', name: 'x', cLang: 'en', folder: 1, tags: [], ts: 1, createTs: 1, id: 'AAAAAAAAAA' };
  const far = applyChapters({ ...base, progress: { chap: 40, ts: 1 } }, chapters, 10, { complete });
  assert.equal(far.latest.chap, 68);
  assert.equal(far.next, undefined); // chapter 41's id is unknown, so no misleading "next = 68"
  const near = applyChapters({ ...base, progress: { chap: 67, ts: 1 } }, chapters, 10, { complete });
  assert.deepEqual(near.next, { chap: 68, slug: '9866083-chapter-68', id: '9866083', ts: 10 });
  assert.equal(chapterUrl(base, near.next), 'https://comix.to/title/1j7n-not-interested-in-dating/9866083-chapter-68');
});

test('bot-challenge pages are recognised (and real pages are not)', () => {
  assert.ok(isBlockedPage(read('cf-challenge-asura-series-403.html')));
  assert.ok(isBlockedPage(read('cf-block-ezmanga-home-403.html')));
  for (const f of ['arena-series.html', 'comix-series.html', 'vortex-series.html', 'mangareadorg-series.html']) assert.ok(!isBlockedPage(read(f)), f);
});

test('sites without a chapter list method say so', async () => {
  await assert.rejects(fetchChapters({ siteId: 'kagane', slug: 'x' }, fakeFetch()), /not supported/);
  await assert.rejects(fetchChapters({ siteId: 'www.webtoon.xyz', slug: '/read/x' }, fakeFetch()), /not supported/);
});
