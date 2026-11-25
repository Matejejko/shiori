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
    await app.click('#openSettings'); await app.click('#menu button[data-tab=io]');
    await app.setInputFiles('#file', fixture.path);
    await app.waitForSelector('#summary .summary');
    assert.match(await app.textContent('#summary'), new RegExp(`${expected} entries`));
    await app.click('#summary button');
    await app.waitForSelector('#summary .ok-text');
    assert.match(await app.textContent('#summary .ok-text'), new RegExp(`now has ${expected} entries`));
    await app.click('#folderTabs button[data-folder=""]');
    await app.waitForFunction((n) => document.querySelectorAll('#grid .tile').length === n, expected);
    assert.equal(await app.textContent('#count'), `${expected} / ${expected}`);
    // tag filter: tick two tags -> only series that have both
    const want = parseExport(fixture.text).entries.filter((x) => [60, 81].every((t) => (x.obj.tags || []).includes(t))).length;
    await app.click('#fTag summary');
    await app.check('#fTag input[value="60"]');
    await app.check('#fTag input[value="81"]');
    await app.waitForFunction((n) => document.querySelectorAll('#grid .tile').length === n, want);
    assert.match(await app.textContent('#fTag summary'), /Action, Fantasy|Fantasy, Action/);
    // series window: opens on a tile, closes on a click outside it
    await app.click('#grid .tile >> nth=0');
    await app.waitForSelector('dialog#edit[open]');
    await app.mouse.click(5, 5);
    await app.waitForFunction(() => !document.querySelector('dialog#edit').open);
    // delete asks in a styled confirmation; Cancel keeps the series
    const countBefore = await app.textContent('#count');
    await app.click('#grid .tile >> nth=0');
    await app.click('#edit .edit-toggle');
    await app.click('#edit button.danger');
    await app.waitForSelector('dialog#confirm[open]');
    assert.match(await app.textContent('#confirm .c-title'), /^Delete “/);
    await app.click('#confirm button[value=cancel]');
    await app.waitForFunction(() => !document.querySelector('dialog#confirm').open);
    await app.keyboard.press('Escape');
    assert.equal(await app.textContent('#count'), countBefore);
    await app.uncheck('#fTag input[value="60"]');
    await app.uncheck('#fTag input[value="81"]');
    await app.click('#fTag summary');
  });

  await t.test('☰ menu opens the Stats page with the library totals', async () => {
    await app.click('#openSettings');
    await app.waitForSelector('#menu:popover-open');
    await app.click('#menu button[data-tab=stats]');
    await app.waitForSelector('#stats .stat-tile');
    assert.equal(await app.evaluate(() => document.querySelector('#menu').matches(':popover-open')), false);
    const chapters = parseExport(fixture.text).entries.reduce((s, x) => s + (typeof x.obj.progress?.chap === 'number' ? Math.floor(x.obj.progress.chap) : 0), 0);
    assert.equal(await app.textContent('#stats .stat-tile .v'), chapters.toLocaleString('en-US'));
    await app.click('#folderTabs button[data-folder=""]');
  });

  await t.test('export through the UI is byte-identical to the imported file', async () => {
    await app.click('#openSettings'); await app.click('#menu button[data-tab=io]');
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
      .replace('<head>', `<head><meta property="og:image" content="http://127.0.0.1:${img.address().port}/cover.png">`)
      // genre links on the page, plus a site menu full of genres that must be ignored
      .replace('<body>', '<body><nav><a href="/genres/romance/">Romance</a><a href="/genres/horror/">Horror</a></nav><div class="mgen"><a href="/genres/action/">Action</a><a href="/genres/fantasy/">Fantasy</a><a href="/genres/xyz/">Not a genre</a></div>');
    await ctx.route('https://arenascan.com/**', (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/manga/e2e-seen/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Seen</title><h1>Seen Series</h1>' });
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
    assert.deepEqual(entry.tags, [60, 81]); // Action, Fantasy — menu genres ignored

    // the tab-update event reaches the tracker asynchronously: wait for it, up to 5 s
    const entryWhen = async (pred) => {
      for (let i = 0; i < 50; i++) {
        const e = await sw.evaluate(async (id) => (await self.shiori.store.getEntry(id)), entry.id);
        if (pred(e)) return e;
        await new Promise((r) => setTimeout(r, 100));
      }
      return sw.evaluate(async (id) => (await self.shiori.store.getEntry(id)), entry.id);
    };
    await site.goto('https://arenascan.com/e2e-pin-test-chapter-7/');
    const after = await entryWhen((e) => e?.progress?.chap === 7);
    assert.equal(after.progress?.chap, 7);

    // forward only: going back to chapter 3 does not regress
    await site.goto('https://arenascan.com/e2e-pin-test-chapter-3/');
    await site.waitForTimeout(300);
    await sw.evaluate(async () => { await self.shiori.store.withLock(async () => {}); });
    assert.equal((await sw.evaluate(async (id) => (await self.shiori.store.getEntry(id)), entry.id)).progress.chap, 7);
    await site.close();
    await popup.close();

    // Comix renders genres with JS; they come from the embedded #initial-data JSON (saved real page)
    const comixHtml = readFileSync(join(SITE_FIXTURES, 'comix-series.html'), 'utf8');
    await ctx.route('https://comix.to/**', (r) => (new URL(r.request().url()).pathname === '/title/1j7n-not-interested-in-dating'
      ? r.fulfill({ status: 200, contentType: 'text/html', body: comixHtml }) : r.fulfill({ status: 404, body: '' })));
    const cx = await ctx.newPage();
    await cx.goto('https://comix.to/title/1j7n-not-interested-in-dating');
    const cxTab = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://comix.to/*' }))[0].id);
    const r = await sw.evaluate((id) => self.shiori.handlers.pin({ tabId: id }), cxTab);
    const pinned = await sw.evaluate(async (id) => self.shiori.store.getEntry(id), r.id);
    assert.equal(pinned.siteId, 'comix');
    for (const t of [70, 119, 14, 27, 26]) assert.ok(pinned.tags.includes(t), `tag ${t} in ${pinned.tags}`); // Comedy Romance Josei Long Strip Full Color
    await cx.close();

    // read chapter 23 of a series that is not pinned, then pin it from its series page: progress = 23
    const rd = await ctx.newPage();
    await rd.goto('https://arenascan.com/e2e-seen-chapter-23/');
    for (let i = 0; i < 50; i++) {
      const seen = await sw.evaluate(async () => (await chrome.storage.local.get('seen')).seen || {});
      if (Object.values(seen).some((x) => x.chap === 23)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await rd.goto('https://arenascan.com/manga/e2e-seen/');
    const rdTab = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://arenascan.com/manga/e2e-seen/' }))[0].id);
    const cur = await sw.evaluate((id) => self.shiori.handlers.currentTab({ tabId: id }), rdTab);
    assert.equal(cur.seen && cur.seen.chap, 23); // the popup can say "You've read up to chapter 23"
    const pr = await sw.evaluate((id) => self.shiori.handlers.pin({ tabId: id }), rdTab);
    const seenEntry = await sw.evaluate(async (id) => self.shiori.store.getEntry(id), pr.id);
    assert.equal(seenEntry.progress.chap, 23);
    assert.equal(seenEntry.progress.slug, 'e2e-seen-chapter-23');
    await rd.close();
  });

  await t.test('settings + sync writes Shiori/library.json to OpenCloud', { skip: !env && 'no OpenCloud configured (test/opencloud/start.sh)' }, async () => {
    const dav = new WebDav(env);
    await dav.delete('Shiori').catch(() => {});
    await app.click('#openSettings'); await app.click('#menu button[data-tab=settings]');
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
    assert.equal(lib.entries.size, expected + 3); // + the series pinned above (Arena, Comix, read-before-pin)
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
