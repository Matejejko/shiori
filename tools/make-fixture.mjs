// Generates test/fixtures/synthetic-export.json: a stand-in for the real MangaPin export
// (same shape and statistics: 103 entries, 91 covers, 8 dangling cover refs, fractional
// chapters, ~46 entries with url). Covers are real WebP files encoded by Chromium.
//
//   node tools/make-fixture.mjs
//
// The real export never goes into git: drop it into test/fixtures/private/ (gitignored)
// and every fixture-driven test runs against it as well.

import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SAMPLE_SERIES } from '../test/fixtures/sample-series.mjs';
import { coverKeyFor } from '../src/lib/mangapin.js';
import { b64ToBytes } from '../src/lib/base64.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let seed = 0x5eed;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const id10 = () => Array.from({ length: 10 }, () => pick(ALNUM)).join('');

async function makeCovers(n) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const out = await page.evaluate(async (n) => {
    const res = [];
    for (let i = 0; i < n; i++) {
      const c = new OffscreenCanvas(48, 68);
      const g = c.getContext('2d');
      g.fillStyle = `hsl(${(i * 137) % 360} 55% 45%)`;
      g.fillRect(0, 0, 48, 68);
      g.fillStyle = '#fff';
      g.font = 'bold 18px sans-serif';
      g.fillText(String(i), 6, 40);
      const blob = await c.convertToBlob({ type: 'image/webp', quality: 0.8 });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (const b of buf) s += String.fromCharCode(b);
      res.push(btoa(s));
    }
    return res;
  }, n);
  await browser.close();
  return out;
}

const T0 = 1735689600000; // 2025-01-01
const entries = [];
const series = SAMPLE_SERIES; // [{siteId, slug, name, url?, chapSlug?(chap)=>string}]
for (let i = 0; i < series.length; i++) {
  const s = series[i];
  const createTs = T0 + Math.floor(rnd() * 200) * 86400000 + Math.floor(rnd() * 86400000);
  const e = { siteId: s.siteId, slug: s.slug };
  if (s.url) e.url = s.url;
  e.name = s.name;
  const hasImg = i % 26 !== 25; // 4 entries without a cover
  if (hasImg) e.img = 'PENDING';
  const latestChap = Math.floor(5 + rnd() * 180) + (rnd() < 0.08 ? 0.5 : 0);
  const readChap = Math.max(0, latestChap - Math.floor(rnd() * 6)) - (rnd() < 0.05 ? 0.5 : 0);
  const pTs = createTs + Math.floor(rnd() * 90) * 86400000;
  const lTs = pTs + Math.floor(rnd() * 5) * 86400000;
  if (readChap < latestChap && rnd() < 0.7) {
    const n = { chap: Math.floor(readChap) + 1 };
    if (s.chapSlug) n.slug = s.chapSlug(n.chap);
    if (rnd() < 0.3) n.id = String(100000 + Math.floor(rnd() * 900000));
    if (rnd() < 0.2) n.group = pick(['Asura', 'Official', 'MTL']);
    n.ts = lTs;
    if (rnd() < 0.3) n.source = s.siteId;
    e.next = n;
  }
  if (rnd() < 0.9) {
    e.latest = { chap: latestChap, ts: lTs };
    if (rnd() < 0.1) e.latest.cycle = Math.floor(rnd() * 4);
  }
  if (rnd() < 0.95) {
    e.progress = { chap: readChap };
    if (s.chapSlug && rnd() < 0.6) e.progress.slug = s.chapSlug(readChap);
    if (rnd() < 0.1) e.progress.group = 'Official';
    e.progress.ts = pTs;
    if (rnd() < 0.1) e.progress.inferVol = 1 + Math.floor(rnd() * 9);
    if (rnd() < 0.1) e.progress.page = 1 + Math.floor(rnd() * 30);
  }
  e.cLang = 'en';
  e.folder = pick([1, 1, 1, 1, 2, 2, 4]);
  if (rnd() < 0.15) e.type = 1;
  e.tags = rnd() < 0.4 ? [pick([1, 2, 3, 4, 5, 6]), pick([7, 8, 9])] : [];
  if (rnd() < 0.3) e.score = 1 + Math.floor(rnd() * 10);
  if (rnd() < 0.3) e.startTs = createTs + 3600000;
  if (rnd() < 0.08) e.endTs = pTs;
  e.ts = Math.max(pTs, lTs) + Math.floor(rnd() * 86400000);
  e.createTs = createTs;
  e.id = id10();
  if (s.rawId) e.rawId = s.rawId;
  if (s.titleId) e.titleId = s.titleId;
  entries.push(e);
}

const withImg = entries.filter((e) => e.img === 'PENDING');
const nCovers = 91;
const covers = await makeCovers(nCovers);
const imgs = {};
withImg.forEach((e, i) => {
  if (i < nCovers) {
    const key = coverKeyFor(b64ToBytes(covers[i]));
    e.img = key;
    imgs[key] = covers[i];
  } else {
    // dangling reference: a cover MangaPin lost (key shape is realistic, bytes are not stored)
    const fake = Array.from({ length: 32 }, () => pick('0123456789abcdef')).join('');
    e.img = `local:${8000 + Math.floor(rnd() * 20000)}:${fake}.webp`;
  }
});

const out = { version: 1, entries, imgs };
mkdirSync(join(here, '../test/fixtures'), { recursive: true });
writeFileSync(join(here, '../test/fixtures/synthetic-export.json'), JSON.stringify(out));
console.log(`wrote ${entries.length} entries, ${Object.keys(imgs).length} covers, ${withImg.length - nCovers} dangling refs, ${entries.filter((e) => e.url).length} with url`);
