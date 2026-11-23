// Site adapters as data. Hosts, title bases and trailing slashes are MangaPin's own
// (sites.json, MangaPin web app 6.14.0, fetched 2026-11-23); URL shapes and chapter-list
// methods were checked against the live sites the same day (fixtures: test/fixtures/sites/).
//
// Per site:
//   host, mirrors[], legacyHosts[]   hostnames (first = canonical for building URLs)
//   seriesRe[], chapterRe[]          regex sources matched against URL.pathname. Named groups:
//                                      slug  = MangaPin `slug`
//                                      cslug = MangaPin chapter slug (progress.slug / next.slug):
//                                              everything after readerBase/<slug>/, like MangaPin
//                                      chap  = chapter number as written in the URL
//                                      cid   = numeric chapter id if present
//   seriesUrl                        path template; {slug} {cslug} {chap} {cid} {slugBase}
//   chapterUrl[]                     path templates, first one whose fields are known wins
//   chapSep                          how decimals are written when building from a number
//   slugKey(slug)                    volatile parts removed, for fuzzy matching
//   slugBase(slug)                   slug as the site's APIs / redirects want it
//   linkSlug                         'base' -> user-facing links use slugBase (redirects to current)
//   list                             how release checks fetch the chapter list (see adapters.js)

const NUM_DASH = '\\d{1,5}(?:-\\d{1,3})?';
const NUM_DOT = '\\d{1,5}(?:\\.\\d{1,3})?';
const NUM_ANY = '\\d{1,5}(?:[.-]\\d{1,3})?';
const SEG = '[^/?#]+';

// MangaThemesia: "0086250808-title" — a rotating 9–12 digit id (MangaPin's own titleId
// derivation strips ^\d{9,12}- and \d{9,12}$).
const stripThemesiaId = (s) => s.replace(/^\d{9,12}-/, '').replace(/-?\d{9,12}$/, '');
// Asura: "title-7de80a82" — 8-hex suffix that the site rotates.
const stripAsuraHash = (s) => s.replace(/-[0-9a-f]{8}$/, '');

// When the series is known, a root-level chapter path is unambiguous: "/{id-}{title}-{N}/".
const reEscape = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const themesiaChapterForSlug = (slug) =>
  `^/(?<cslug>(?:\\d{9,12}-)?${reEscape(stripThemesiaId(slug))}-(?:chapter-)?(?<chap>${NUM_DASH}))/?$`;

const json = (text) => { try { return JSON.parse(text); } catch { return null; } };

export const SITES = {
  comix: {
    name: 'Comix', host: 'comix.to', mirrors: ['comix.ws'],
    seriesRe: [`^/title/(?<slug>${SEG})/?$`],
    chapterRe: [`^/title/(?<slug>${SEG})/(?<cslug>(?<cid>\\d+)-chapter-(?<chap>${NUM_DOT}))/?$`],
    seriesUrl: '/title/{slug}',
    chapterUrl: ['/title/{slug}/{cslug}'], // chapter ids are not derivable from the number (verified: 404)
    slugKey: (s) => s.split('-')[0],       // "1j7n-not-interested-in-dating": the hid is the stable id
    // The series page embeds only firstChapterUrl/latestChapterUrl (full list API is token-gated),
    // so the list is partial: good for "is there something new", not for "which one is next".
    list: { complete: false },
  },
  vortex: {
    name: 'Vortex Scans', host: 'vortexscans.org', mirrors: ['vortexmanga.com'],
    seriesRe: [`^/series/(?<slug>${SEG})/?$`],
    chapterRe: [`^/series/(?<slug>${SEG})/(?<cslug>chapter-(?<chap>${NUM_ANY})[^/?#]*)/?$`],
    seriesUrl: '/series/{slug}',
    chapterUrl: ['/series/{slug}/{cslug}', '/series/{slug}/chapter-{chap}'],
    chapSep: '.',
    list: {
      requests: (e) => [
        { url: `https://api.vortexscans.org/api/post?postSlug=${encodeURIComponent(e.slug)}`, step: 'post' },
        (ctx) => ctx.postId ? { url: `https://api.vortexscans.org/api/chapters?postId=${ctx.postId}&skip=0&take=999&order=desc`, step: 'chapters' } : null,
      ],
      parse: (e, text, req) => {
        const d = json(text);
        if (req.step === 'post') {
          const last = d && d.lastChapter;
          return { ctx: { postId: d && d.post && d.post.id }, chapters: last && typeof last.number === 'number' ? [{ chap: last.number, slug: last.slug }] : [], complete: false };
        }
        const list = (d && d.post && d.post.chapters) || [];
        return { chapters: list.filter((c) => typeof c.number === 'number').map((c) => ({ chap: c.number, slug: c.slug, id: c.id })), complete: true };
      },
    },
  },
  thunder: {
    name: 'Thunderscans EN', host: 'en-thunderscans.com',
    seriesRe: [`^/comics/(?<slug>${SEG})/?$`],
    chapterRe: [
      `^/(?<cslug>(?<slug>[a-z0-9-]+?)-chapter-(?<chap>${NUM_DASH}))/?$`,
      `^/(?<cslug>\\d{9,12}-(?<slug>[a-z0-9-]+?)-(?<chap>\\d{1,5}))/?$`, // some chapters drop "chapter-" (integer only: "-8-12" is ambiguous)
    ],
    seriesUrl: '/comics/{slug}/',
    chapterUrl: ['/{cslug}/', '/{slugBase}-chapter-{chap}/'],
    chapSep: '-',
    slugKey: stripThemesiaId, slugBase: stripThemesiaId,
    chapterForSlug: themesiaChapterForSlug,
    linkSlug: 'base', // /comics/<title>/ 301-redirects to the current prefixed URL; a stale prefix 404s
    list: { requests: (e, a) => [{ url: `https://${a.host}/comics/${encodeURIComponent(stripThemesiaId(e.slug))}/` }], complete: true },
  },
  asura: {
    name: 'Asura Scans', host: 'asurascans.com', legacyHosts: ['asuracomic.net', 'asura.gg', 'asuratoon.com'],
    seriesRe: [`^/comics/(?<slug>${SEG})/?$`, `^/series/(?<slug>${SEG})/?$`],
    chapterRe: [`^/comics/(?<slug>${SEG})/chapter/(?<cslug>(?<chap>${NUM_DOT}))/?$`, `^/series/(?<slug>${SEG})/chapter/(?<cslug>(?<chap>${NUM_DOT}))/?$`],
    seriesUrl: '/comics/{slug}',
    chapterUrl: ['/comics/{slug}/chapter/{chap}'],
    chapSep: '.',
    slugKey: stripAsuraHash, slugBase: stripAsuraHash,
    // HTML is behind a Cloudflare challenge; the JSON API is not, and accepts the hash-less slug.
    list: {
      requests: (e) => [{ url: `https://api.asurascans.com/api/series/${encodeURIComponent(stripAsuraHash(e.slug))}/chapters` }],
      parse: (e, text) => {
        const d = json(text);
        const list = (d && Array.isArray(d.data) && d.data) || [];
        return { chapters: list.filter((c) => typeof c.number === 'number').map((c) => ({ chap: c.number, slug: String(c.number), id: c.id })), complete: true };
      },
    },
  },
  arena: {
    name: 'Arena Scans', host: 'arenascan.com',
    seriesRe: [`^/manga/(?<slug>${SEG})/?$`],
    chapterRe: [`^/(?<cslug>(?<slug>[a-z0-9-]+?)-chapter-(?<chap>${NUM_DASH}))/?$`],
    seriesUrl: '/manga/{slug}/',
    chapterUrl: ['/{cslug}/', '/{slug}-chapter-{chap}/'],
    chapSep: '-',
    slugKey: stripThemesiaId,
    chapterForSlug: themesiaChapterForSlug,
    list: { complete: true },
  },
  kingofshojo: {
    name: 'King of Shojo', host: 'kingofshojo.com',
    seriesRe: [`^/manga/(?<slug>${SEG})/?$`],
    chapterRe: [`^/(?<cslug>(?<slug>[a-z0-9-]+?)-chapter-(?<chap>${NUM_DASH}))/?$`],
    seriesUrl: '/manga/{slug}/',
    chapterUrl: ['/{cslug}/', '/{slug}-chapter-{chap}/'],
    chapSep: '-',
    slugKey: stripThemesiaId,
    chapterForSlug: themesiaChapterForSlug,
    list: { complete: true },
  },
  rolia: {
    name: 'Rolia Scans', host: 'roliascan.com',
    seriesRe: [`^/manga/(?<slug>${SEG})/?$`],
    chapterRe: [`^/read/(?<slug>${SEG})/(?<cslug>ch(?<chap>${NUM_DASH})-(?<cid>\\d+))/?$`],
    seriesUrl: '/manga/{slug}/',
    chapterUrl: ['/read/{slug}/{cslug}/'], // the trailing id is a per-chapter post id
    chapSep: '-',
    // Chapter list comes from a JSON endpoint keyed by the numeric manga id: MangaPin's
    // rawId when present, otherwise <body data-manga-id> on the series page.
    list: {
      requests: (e, a) => [
        /^\d+$/.test(String(e.rawId || '')) ? null : { url: `https://${a.host}/manga/${encodeURIComponent(e.slug)}/`, step: 'page' },
        (ctx) => {
          const id = /^\d+$/.test(String(e.rawId || '')) ? e.rawId : ctx.mangaId;
          return id ? { url: `https://${a.host}/auth/manga-chapters?manga_id=${id}&offset=0&limit=500&order=DESC`, step: 'api' } : null;
        },
      ],
      parse: (e, text, req, ctx, h) => {
        if (req.step === 'page') {
          const m = /data-manga-id="(\d+)"/.exec(text);
          return { ctx: { mangaId: m && m[1] }, chapters: [] };
        }
        const d = json(text);
        const out = new Map();
        for (const c of (d && d.chapters) || []) {
          const chap = h.parseChapNumber(c.chapter);
          if (chap === null || out.has(chap)) continue; // several groups may upload the same number
          const m = typeof c.url === 'string' ? /\/read\/[^/]+\/([^/]+)\/?$/.exec(c.url) : null;
          out.set(chap, { chap, slug: m ? m[1] : undefined, id: c.id });
        }
        return { chapters: [...out.values()], complete: !(d && d.has_more) };
      },
    },
  },
  ezmanga: {
    name: 'EZ Manga', host: 'ezmanga.org',
    seriesRe: [`^/series/(?<slug>${SEG})/?$`],
    chapterRe: [`^/series/(?<slug>${SEG})/(?<cslug>chapter-(?<chap>${NUM_ANY})[^/?#]*)/?$`],
    seriesUrl: '/series/{slug}',
    chapterUrl: ['/series/{slug}/{cslug}', '/series/{slug}/chapter-{chap}'],
    chapSep: '-',
    // MangaPin's own chapters endpoint for this site (its only JSON-configured site)
    list: {
      requests: (e) => [{ url: `https://vapi.ezmanga.org/api/v1/series/${encodeURIComponent(e.slug)}/chapters?page=1&perPage=100&sort=desc` }],
      parse: (e, text) => {
        const d = json(text);
        const list = (d && Array.isArray(d.data) && d.data) || [];
        return { chapters: list.filter((c) => typeof c.number === 'number').map((c) => ({ chap: c.number, slug: c.slug, id: c.id })), complete: !(d && d.totalPages > 1) };
      },
    },
  },
  valir: {
    name: 'Valir Scans', host: 'valirscans.org',
    seriesRe: [`^/series/comic/(?<slug>${SEG})/?$`],
    chapterRe: [`^/series/comic/(?<slug>${SEG})/chapter/(?<cslug>(?<chap>${NUM_DOT}))/?$`],
    seriesUrl: '/series/comic/{slug}',
    chapterUrl: ['/series/comic/{slug}/chapter/{chap}'],
    chapSep: '.',
    // Next.js: every chapter is in the RSC flight data ("chapters":[{"number":1,…}]) even when
    // only some are rendered as links; the page may be paged (?page=N, "totalPages").
    list: {
      parse: (e, text, req, ctx, h) => {
        const flat = text.replace(/\\"/g, '"');
        const pages = /"totalPages":(\d+)/.exec(flat);
        const byNum = new Map(h.extractChapterLinks(e, text, req.url).map((c) => [c.chap, c]));
        const start = flat.indexOf('"chapters":[');
        if (start >= 0) {
          const end = flat.indexOf('"currentPage"', start);
          const body = flat.slice(start, end > start ? end : start + 500000);
          for (const m of body.matchAll(/"number":(\d{1,5}(?:\.\d{1,3})?)/g)) {
            const chap = Number(m[1]);
            if (!byNum.has(chap)) byNum.set(chap, { chap, slug: m[1] });
          }
        }
        return { chapters: [...byNum.values()], complete: !(pages && Number(pages[1]) > 1) };
      },
    },
  },
  mangareadorg: {
    name: 'MangaRead', host: 'www.mangaread.org', mirrors: ['mangaread.org'],
    seriesRe: [`^/manga/(?<slug>${SEG})/?$`],
    chapterRe: [`^/manga/(?<slug>${SEG})/(?<cslug>chapter-(?<chap>${NUM_DASH})[^/?#]*)/?$`],
    seriesUrl: '/manga/{slug}/',
    chapterUrl: ['/manga/{slug}/{cslug}/', '/manga/{slug}/chapter-{chap}/'],
    chapSep: '-',
    // Madara: chapters are in the series HTML; newer installs load them via POST <series>/ajax/chapters/
    list: {
      requests: (e, a) => [
        { url: `https://${a.host}/manga/${encodeURIComponent(e.slug)}/`, step: 'page' },
        (ctx) => ctx.found ? null : { url: `https://${a.host}/manga/${encodeURIComponent(e.slug)}/ajax/chapters/`, method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' }, step: 'ajax' },
      ],
      parse: (e, text, req, ctx, h) => {
        const chapters = h.extractChapterLinks(e, text, req.url);
        return { chapters, ctx: { found: chapters.length > 0 }, complete: true };
      },
    },
  },
  kagane: {
    name: 'Kagane', host: 'kagane.moe', mirrors: ['kagane.to', 'kagane.cx', 'kagane.si', 'kagane.net', 'kagane.org'],
    seriesRe: [`^/series/(?<slug>${SEG})/?$`],
    // reader URLs carry an opaque chapter id, not a number -> pages are recognised but chapters
    // cannot be tracked from the URL; everything is behind a Cloudflare challenge -> no list.
    chapterRe: [`^/series/(?<slug>${SEG})/reader/(?<cslug>${SEG})/?$`],
    seriesUrl: '/series/{slug}',
    chapterUrl: ['/series/{slug}/reader/{cslug}'],
    list: null,
  },
};
