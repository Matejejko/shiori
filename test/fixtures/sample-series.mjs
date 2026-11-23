// Series for the synthetic MangaPin export: same site mix as the real library
// (comix 70, vortex 9, thunder 7, asura 4, 1 each of arena/rolia/ezmanga/valir/kingofshojo/
// mangareadorg/kagane, 6 generic-hostname entries) with slug/chapter-slug shapes as MangaPin
// stores them (verified against the live sites, see test/fixtures/sites/).

const words = ['shadow', 'monarch', 'return', 'tower', 'dragon', 'tamer', 'sword', 'night', 'duke', 'family', 'level', 'max', 'newbie', 'regressor', 'academy', 'villain', 'princess', 'moon', 'blade', 'heaven', 'demon', 'king', 'ranker', 'hunter', 'archmage', 'genius', 'doctor', 'chef', 'reborn', 'system'];
let s = 7;
const r = () => ((s = (s * 48271) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(r() * a.length)];
const title = (n = 3 + Math.floor(r() * 4)) => Array.from({ length: n }, () => pick(words)).join('-');
const nameOf = (slug) => slug.replace(/^\d{9,12}-/, '').replace(/-[0-9a-f]{8}$/, '').split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const b36 = (n) => n.toString(36);
const dot = (n) => String(n);
const dash = (n) => String(n).replace('.', '-');

const out = [];
const seen = new Set();
function add(o) { if (seen.has(o.siteId + o.slug)) return false; seen.add(o.siteId + o.slug); out.push(o); return true; }

for (let i = 0; out.length < 70; i++) {
  const slug = `${b36(1000 + Math.floor(r() * 1e6))}-${title()}`;
  const base = 5000000 + Math.floor(r() * 5e6);
  add({ siteId: 'comix', slug, name: nameOf(slug.slice(slug.indexOf('-') + 1)), url: i % 9 < 4 ? `https://comix.to/title/${slug}` : undefined, chapSlug: (n) => `${base + Math.round(n * 10)}-chapter-${dot(n)}` });
}
const vortex = [];
while (vortex.length < 9) { const slug = vortex.length === 0 ? "a-wimp's-strategy-guide-to-conquer-the-tower" : title(); if (!vortex.includes(slug)) vortex.push(slug); }
vortex.forEach((slug, i) => add({ siteId: 'vortex', slug, name: nameOf(slug.replace("'", '')), titleId: slug.replace(/[^a-z0-9-]/g, '-'), url: i % 2 ? `https://vortexscans.org/series/${slug}` : undefined, chapSlug: (n) => `chapter-${dot(n)}` }));
for (let i = 0; i < 7; i++) {
  const base = title();
  const slug = i < 4 ? `${String(1000000000 + Math.floor(r() * 8e9)).padStart(10, '0')}-${base}` : base;
  add({ siteId: 'thunder', slug, name: nameOf(base), titleId: base, url: i % 2 ? `https://en-thunderscans.com/comics/${slug}/` : undefined, chapSlug: (n) => `${base}-chapter-${dash(n)}` });
}
for (let i = 0; i < 4; i++) {
  const base = title();
  const slug = `${base}-7de80a82`;
  add({ siteId: 'asura', slug, name: nameOf(base), titleId: base, url: i % 2 ? `https://asurascans.com/comics/${slug}` : undefined, chapSlug: (n) => dot(n) });
}
add({ siteId: 'arena', slug: 'a-portrait-of-pride', name: 'A Portrait of Pride', url: 'https://arenascan.com/manga/a-portrait-of-pride/', rawId: '81234', chapSlug: (n) => `a-portrait-of-pride-chapter-${dash(n)}` });
add({ siteId: 'rolia', slug: 'goblin-corporation', name: 'Goblin Corporation', rawId: '275456', url: 'https://roliascan.com/manga/goblin-corporation/', chapSlug: (n) => `ch${dash(n)}-${275400 + Math.round(n * 10)}` });
add({ siteId: 'ezmanga', slug: 'the-kind-intruder', name: 'The Kind Intruder', chapSlug: (n) => `chapter-${dash(n)}` });
add({ siteId: 'valir', slug: 'became-a-family-with-the-four-duke-brothers', name: 'Became a Family with the Four Duke Brothers', url: 'https://valirscans.org/series/comic/became-a-family-with-the-four-duke-brothers', chapSlug: (n) => dot(n) });
add({ siteId: 'kingofshojo', slug: 'anyone-can-see-its-a-beast', name: 'Anyone Can See It’s A Beast', titleId: 'anyone-can-see-it-s-a-beast', chapSlug: (n) => `anyone-can-see-its-a-beast-chapter-${dash(n)}` });
add({ siteId: 'mangareadorg', slug: 'a-i-doctor', name: 'A.I. Doctor', rawId: '414927', titleId: '414927', url: 'https://www.mangaread.org/manga/a-i-doctor/', chapSlug: (n) => `chapter-${dash(n)}` });
add({ siteId: 'kagane', slug: '7XQ2M9KD3P', name: 'Kagane Series “Quoted” <b>not bold</b>', chapSlug: () => 'C' + Math.floor(r() * 1e9).toString(36).toUpperCase() });
// generic sites: MangaPin stores the series path as the slug
add({ siteId: 'www.webtoon.xyz', slug: '/read/tower-of-god', name: 'Tower of God', url: 'https://www.webtoon.xyz/read/tower-of-god/', chapSlug: (n) => `/read/tower-of-god/chapter-${dash(n)}/` });
add({ siteId: 'www.webtoon.xyz', slug: '/read/the-boxer', name: 'The Boxer', chapSlug: (n) => `/read/the-boxer/chapter-${dash(n)}/` });
add({ siteId: 'www.webtoon.xyz', slug: '/read/위대한-한국어-제목', name: '위대한 한국어 제목', url: 'https://www.webtoon.xyz/read/%EC%9C%84%EB%8C%80%ED%95%9C-%ED%95%9C%EA%B5%AD%EC%96%B4-%EC%A0%9C%EB%AA%A9/' });
add({ siteId: 'my.mangapin.com', slug: 'Qm9vayAx', name: 'Imported without a reading source' });
add({ siteId: 'my.mangapin.com', slug: 'Qm9vayAy', name: 'Emoji name 📚 and \\ backslash' });
add({ siteId: 'my.mangapin.com', slug: 'Qm9vayAz', name: 'Line\nbreak and   separator' });

if (out.length !== 103) throw new Error('expected 103 series, got ' + out.length);
export const SAMPLE_SERIES = out;
