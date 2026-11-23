// Site table (data only). Hosts / title bases / trailing slashes come from MangaPin's own
// sites.json (web app 6.14.0, fetched 2026-11-23); chapter URL shapes and chapter-list
// methods were verified against live pages the same day (fixtures in test/fixtures/sites/).
//
// series / chapter: path templates (first = canonical, used to build URLs)
// list:  how release checks get the chapter list (default: chapter links in the series page)

// MangaThemesia sites prefix slugs with a volatile numeric id ("0086250808-title") that
// changes when they re-upload; compare without it.
const stripNumericPrefix = (s) => s.replace(/^\d{6,}-/, '');

export const SITES = {
  comix: {
    name: 'Comix', host: 'comix.to', mirrors: ['comix.ws'],
    series: ['/title/{slug}'],
    chapter: ['/title/{slug}/{cid}-chapter-{chap}'],
    chapSep: '-',
    list: {},
  },
  vortex: {
    name: 'Vortex Scans', host: 'vortexscans.org', mirrors: ['vortexmanga.com'],
    series: ['/series/{slug}'],
    chapter: ['/series/{slug}/chapter-{chap}'],
    chapSep: '-',
    list: {},
  },
  thunder: {
    name: 'Thunderscans EN', host: 'en-thunderscans.com',
    series: ['/comics/{slug}/'],
    chapter: ['/{slug}-chapter-{chap}/'],
    chapSep: '-',
    slugKey: stripNumericPrefix,
    list: {},
  },
  asura: {
    name: 'Asura Scans', host: 'asurascans.com', legacyHosts: ['asuracomic.net', 'asura.gg', 'asuratoon.com'],
    series: ['/comics/{slug}', '/series/{slug}'],
    chapter: ['/comics/{slug}/chapter/{chap}', '/series/{slug}/chapter/{chap}'],
    chapSep: '.',
    list: {},
  },
  arena: {
    name: 'Arena Scans', host: 'arenascan.com',
    series: ['/manga/{slug}/'],
    chapter: ['/{slug}-chapter-{chap}/'],
    chapSep: '-',
    slugKey: stripNumericPrefix,
    list: {},
  },
  rolia: {
    name: 'Rolia Scans', host: 'roliascan.com',
    series: ['/manga/{slug}/'],
    chapter: ['/read/{slug}/ch{chap}-{cid}/'],
    chapSep: '.',
    list: {},
  },
  ezmanga: {
    name: 'EZ Manga', host: 'ezmanga.org',
    series: ['/series/{slug}'],
    chapter: ['/series/{slug}/chapter-{chap}', '/series/{slug}/{cslug}'],
    chapSep: '-',
    list: {},
  },
  valir: {
    name: 'Valir Scans', host: 'valirscans.org',
    series: ['/series/comic/{slug}'],
    chapter: ['/series/comic/{slug}/chapter/{chap}'],
    chapSep: '.',
    list: {},
  },
  kingofshojo: {
    name: 'King of Shojo', host: 'kingofshojo.com',
    series: ['/manga/{slug}/'],
    chapter: ['/{slug}-chapter-{chap}/'],
    chapSep: '-',
    slugKey: stripNumericPrefix,
    list: {},
  },
  mangareadorg: {
    name: 'MangaRead', host: 'www.mangaread.org',
    series: ['/manga/{slug}/'],
    chapter: ['/manga/{slug}/chapter-{chap}/'],
    chapSep: '-',
    list: {},
  },
  kagane: {
    name: 'Kagane', host: 'kagane.moe', mirrors: ['kagane.to', 'kagane.cx', 'kagane.si', 'kagane.net', 'kagane.org'],
    series: ['/series/{slug}'],
    chapter: ['/series/{slug}/reader/{cslug}'],
    list: {},
  },
};
