// Headless Chromium end-to-end: the real extension, real chrome.storage, real UI.
// Skips when Playwright is not installed. The sync part needs an OpenCloud (see sync.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { exportFixtures, davEnv, loadPlaywright } from './helpers.mjs';
import { WebDav } from '../src/lib/webdav.js';
import { fromDoc } from '../src/lib/sync.js';
import { parseExport } from '../src/lib/mangapin.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pw = await loadPlaywright();
const env = davEnv();
const fixture = exportFixtures().at(-1); // the real export when present, else the synthetic one
const SITE_FIXTURES = join(root, 'test/fixtures/sites');

test('e2e: extension in headless Chromium', { skip: !pw && 'playwright not installed (npm i -D playwright)', timeout: 180_000 }, async (t) => {
  const profile = mkdtempSync(join(tmpdir(), 'shiori-e2e-'));
  const ctx = await pw.chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    acceptDownloads: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  });
  const consoleErrors = [];
  const watch = (p, label) => {
    p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${label}: ${m.text()}`); });
    p.on('pageerror', (e) => consoleErrors.push(`${label}: ${e.message}`));
  };
  t.after(async () => { await ctx.close(); rmSync(profile, { recursive: true, force: true }); });

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  const base = `chrome-extension://${id}`;

  await t.test('loads with zero errors and warnings', async () => {
    const page = await ctx.newPage();
    await page.goto(`chrome://extensions/?id=${id}`);
    const info = await page.evaluate((id) => new Promise((r) => chrome.developerPrivate.getExtensionInfo(id, r)), id);
    await page.close();
    assert.deepEqual(info.manifestErrors.map((e) => e.message), []);
    assert.deepEqual(info.runtimeErrors.map((e) => e.message), []);
    assert.deepEqual(info.installWarnings, []);
    assert.equal(info.state, 'ENABLED');
  });

  const app = await ctx.newPage();
  watch(app, 'app');
  await app.goto(`${base}/src/app/app.html`);
  const expected = parseExport(fixture.text).entries.length;

  await t.test(`import shows ${expected} entries`, async () => {
    await app.click('button[data-tab=io]');
    await app.setInputFiles('#file', fixture.path);
    await app.waitForSelector('#summary .summary');
    assert.match(await app.textContent('#summary'), new RegExp(`${expected} entries`));
    await app.click('#summary button');
    await app.waitForSelector('#summary .ok-text');
    assert.match(await app.textContent('#summary .ok-text'), new RegExp(`now has ${expected} entries`));
    await app.click('button[data-tab=library]');
    await app.waitForFunction((n) => document.querySelectorAll('#grid .tile').length === n, expected);
    assert.equal(await app.textContent('#count'), `${expected} / ${expected}`);
  });

  await t.test('export through the UI is byte-identical to the imported file', async () => {
    await app.click('button[data-tab=io]');
    const [dl] = await Promise.all([app.waitForEvent('download'), app.click('#export')]);
    assert.match(dl.suggestedFilename(), /^MangaPin\d{12}\.json$/);
    const text = readFileSync(await dl.path(), 'utf8');
    assert.equal(text.length, fixture.text.length);
    assert.ok(text === fixture.text, 'exported file differs from the import');
  });

  await t.test('pin from the popup, then reading a chapter advances progress', async (t) => {
    // serve a real (saved) Arena Scans series page + a chapter page without touching the network
    // the saved page plus an og:image served by a local HTTP server: the background worker
    // fetches it itself (all network I/O happens there) -> exercises the whole cover path
    const png = Buffer.from(await app.evaluate(async () => {
      const c = new OffscreenCanvas(600, 850);
      const g = c.getContext('2d');
      g.fillStyle = '#336699'; g.fillRect(0, 0, 600, 850);
      g.fillStyle = '#ffcc00'; g.fillRect(50, 50, 500, 300);
      const b = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
      let str = ''; for (const x of b) str += String.fromCharCode(x);
      return btoa(str);
    }), 'base64');
    const img = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); });
    await new Promise((r) => img.listen(0, '127.0.0.1', r));
    t.after(() => img.close());
    const seriesHtml = readFileSync(join(SITE_FIXTURES, 'arena-series.html'), 'utf8')
      .replace('<head>', `<head><meta property="og:image" content="http://127.0.0.1:${img.address().port}/cover.png">`);
    await ctx.route('https://arenascan.com/**', (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/manga/e2e-pin-test/') return route.fulfill({ status: 200, contentType: 'text/html', body: seriesHtml });
      if (/chapter-\d+\/$/.test(u.pathname)) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>chapter</title><h1>Chapter</h1>' });
      return route.fulfill({ status: 404, body: '' });
    });
    const site = await ctx.newPage();
    watch(site, 'site');
    await site.goto('https://arenascan.com/manga/e2e-pin-test/');
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://arenascan.com/*' }))[0].id);

    const popup = await ctx.newPage();
    watch(popup, 'popup');
    await popup.goto(`${base}/src/popup/popup.html?tab=${tabId}`);
    await popup.waitForSelector('#current form button[type=submit]');
    assert.match(await popup.textContent('#current'), /Arena Scans series/);
    await popup.click('#current form button[type=submit]');
    await popup.waitForFunction(() => /Pinned|Already/.test(document.querySelector('#current')?.textContent || '') || document.querySelector('#current .title')?.textContent?.includes('Portrait'));

    const entry = await sw.evaluate(async () => {
      const lib = await self.shiori.store.loadLibrary();
      return [...lib.entries.values()].find((e) => e.siteId === 'arena' && e.slug === 'e2e-pin-test');
    });
    assert.ok(entry, 'pinned entry exists');
    // cover: ~240px wide WebP, keyed local:<bytes>:<md5>.webp exactly like MangaPin
    assert.match(entry.img || '', /^local:\d+:[0-9a-f]{32}\.webp$/);
    const cover = await sw.evaluate(async (key) => {
      const b64 = await self.shiori.store.getCover(key);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }));
      return { len: bytes.length, magic: String.fromCharCode(...bytes.slice(8, 12)), w: bmp.width, h: bmp.height, b64 };
    }, entry.img);
    assert.equal(cover.magic, 'WEBP');
    assert.equal(cover.w, 240);
    assert.equal(cover.h, 340);
    const [, bytes, md5hex] = /^local:(\d+):([0-9a-f]{32})\.webp$/.exec(entry.img);
    assert.equal(Number(bytes), cover.len);
    assert.equal(createHash('md5').update(Buffer.from(cover.b64, 'base64')).digest('hex'), md5hex);
    assert.equal(entry.name, 'A Portrait of Pride'); // scraped from the page's h1
    assert.match(entry.id, /^[A-Za-z0-9]{10}$/);

    await site.goto('https://arenascan.com/e2e-pin-test-chapter-7/');
    await sw.evaluate(async () => { await self.shiori.store.withLock(async () => {}); });
    const after = await sw.evaluate(async (id) => (await self.shiori.store.getEntry(id)), entry.id);
    assert.equal(after.progress.chap, 7);

    // forward only: going back to chapter 3 does not regress
    await site.goto('https://arenascan.com/e2e-pin-test-chapter-3/');
    await site.waitForTimeout(300);
    await sw.evaluate(async () => { await self.shiori.store.withLock(async () => {}); });
    assert.equal((await sw.evaluate(async (id) => (await self.shiori.store.getEntry(id)), entry.id)).progress.chap, 7);
    await site.close();
    await popup.close();
  });

  await t.test('settings + sync writes Shiori/library.json to OpenCloud', { skip: !env && 'no OpenCloud configured (test/opencloud/start.sh)' }, async () => {
    const dav = new WebDav(env);
    await dav.delete('Shiori').catch(() => {});
    await app.click('button[data-tab=settings]');
    await app.fill('#settings [name=davUrl]', env.url);
    await app.fill('#settings [name=user]', env.user);
    await app.fill('#settings [name=token]', env.token);
    await app.click('#test');
    await app.waitForFunction(() => /Connected|error|HTTP|check/i.test(document.querySelector('#settingsMsg').textContent));
    assert.match(await app.textContent('#settingsMsg'), /Connected/);
    await app.click('#settings button[type=submit]');
    await app.waitForFunction(() => document.querySelector('#settingsMsg').textContent === 'Saved.');
    const r = await sw.evaluate(() => self.shiori.runSync('manual'));
    assert.equal(r.ok, true, JSON.stringify(r));

    const doc = await dav.getText('Shiori/library.json');
    assert.ok(doc, 'library.json exists');
    const lib = fromDoc(doc.text);
    assert.equal(lib.entries.size, expected + 1); // + the series pinned above
    const covers = await dav.propfind('Shiori/covers/', 1);
    assert.ok(covers.filter((x) => !x.self).length >= parseExport(fixture.text).imgs.size);
    // the token never lands in synced data or in plain settings
    assert.ok(!doc.text.includes(env.token));
    const stored = await sw.evaluate(async () => JSON.stringify(await chrome.storage.local.get('cfg')));
    assert.ok(!stored.includes(env.token));
    await dav.delete('Shiori').catch(() => {});
  });

  await t.test('no console errors on extension pages', () => {
    assert.deepEqual(consoleErrors.filter((e) => !/net::ERR_|Failed to load resource/.test(e)), []);
  });
});
