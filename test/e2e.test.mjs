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
import { exportFixtures, davEnv, loadPlaywright, backupContent, mangapinContent } from './helpers.mjs';
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
  // a Stats tile's value, found by its label (the page's sections can move)
  const statValue = (label) => app.$$eval('#stats .stat-tile', (tiles, l) => tiles.find((t) => t.querySelector('.l')?.textContent === l)?.querySelector('.v')?.textContent ?? null, label);

  await t.test(`import shows ${expected} entries`, async () => {
    await app.click('#openSettings'); await app.click('#menu button[data-tab=io]');
    await app.setInputFiles('#file', fixture.path);
    // "Shiori backup" is the default: a MangaPin file is refused with a hint, not guessed
    await app.waitForSelector('#summary .err-text');
    assert.match(await app.textContent('#summary .err-text'), /MangaPin export/);
    await app.check('input[name=source][value=mangapin]');
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
    await app.check('#fTag input[value="Action"]'); // tags are names (MangaPin's 60 and 81)
    await app.check('#fTag input[value="Fantasy"]');
    await app.waitForFunction((n) => document.querySelectorAll('#grid .tile').length === n, want);
    assert.match(await app.textContent('#fTag summary'), /Action, Fantasy|Fantasy, Action/);
    // the tag filter closes like the selects next to it: a click elsewhere, or Escape
    await app.click('#count');
    assert.equal(await app.$eval('#fTag', (d) => d.open), false);
    await app.click('#fTag summary');
    await app.keyboard.press('Escape');
    assert.equal(await app.$eval('#fTag', (d) => d.open), false);
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
    // unsaved edits: Close asks (Cancel keeps editing); Escape warns once, a second Escape discards
    await app.click('#grid .tile >> nth=0');
    await app.click('#edit .edit-toggle');
    await app.fill('#edit input[type=number][step=any]:not([min])', '7');
    await app.click('#edit button:text-is("Close")');
    await app.waitForSelector('dialog#confirm[open]');
    assert.equal(await app.textContent('#confirm .c-title'), 'Discard your changes?');
    await app.click('#confirm button[value=cancel]');
    assert.equal(await app.$eval('dialog#edit', (d) => d.open), true);
    await app.keyboard.press('Escape');
    assert.equal(await app.$eval('dialog#edit', (d) => d.open), true);
    assert.match(await app.textContent('#edit .ed-foot'), /press Escape again/);
    await app.keyboard.press('Escape');
    await app.waitForFunction(() => !document.querySelector('dialog#edit').open);
    await app.click('#fTag summary');
    await app.uncheck('#fTag input[value="Action"]');
    await app.uncheck('#fTag input[value="Fantasy"]');
    await app.click('#fTag summary');
  });

  await t.test('☰ menu opens the Stats page with the library totals', async () => {
    await app.click('#openSettings');
    await app.waitForSelector('#menu:popover-open');
    await app.click('#menu button[data-tab=stats]');
    await app.waitForSelector('#stats .stat-tile');
    assert.equal(await app.evaluate(() => document.querySelector('#menu').matches(':popover-open')), false);
    const chapters = parseExport(fixture.text).entries.reduce((s, x) => s + (typeof x.obj.progress?.chap === 'number' ? Math.floor(x.obj.progress.chap) : 0), 0);
    assert.equal(await statValue('Chapters read'), chapters.toLocaleString('en-US'));
    await app.click('#folderTabs button[data-folder=""]');
  });

  await t.test('export through the UI is a Shiori backup holding every imported entry and cover', async () => {
    await app.click('#openSettings'); await app.click('#menu button[data-tab=io]');
    const [dl] = await Promise.all([app.waitForEvent('download'), app.click('#export')]);
    assert.match(dl.suggestedFilename(), /^Shiori-\d{8}\.json$/);
    const text = readFileSync(await dl.path(), 'utf8');
    assert.equal(JSON.parse(text).format, 'shiori-backup');
    assert.ok(backupContent(text) === mangapinContent(fixture.text), 'backup differs from the imported entries/covers');
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
    assert.deepEqual(entry.tags, ['Action', 'Fantasy', 'Not a genre']); // every genre of the series, not only MangaPin's; menu genres ignored

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
    // comix's generic fields only (genres, demographics, formats); its fine-grained `tags` are skipped
    assert.deepEqual(pinned.tags, ['Comedy', 'Romance', 'Josei', 'Long Strip', 'Full Color']);
    await cx.close();

    // read chapter 23 of a series that is not pinned, then pin it from its series page: progress = 23
    const rd = await ctx.newPage();
    await rd.goto('https://arenascan.com/e2e-seen-chapter-23/');
    for (let i = 0; i < 50; i++) {
      const seen = await sw.evaluate(async () => (await chrome.storage.local.get('lib')).lib?.seen || {});
      if (Object.values(seen).some((x) => x.chap === 23)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // Stats counts it before you pin: "incl. unpinned" = pinned chapters + 23
    const statNums = async () => {
      await app.click('#openSettings'); await app.click('#menu button[data-tab=stats]');
      await app.waitForSelector('#stats .stat-tile');
      return [await statValue('Chapters read'), await statValue('Chapters incl. unpinned')].map((x) => Number(x.replace(/[^0-9]/g, '')));
    };
    const [pinnedCh, allCh] = await statNums();
    assert.equal(allCh - pinnedCh, 23);
    await rd.goto('https://arenascan.com/manga/e2e-seen/');
    const rdTab = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://arenascan.com/manga/e2e-seen/' }))[0].id);
    const cur = await sw.evaluate((id) => self.shiori.handlers.currentTab({ tabId: id }), rdTab);
    assert.equal(cur.seen && cur.seen.chap, 23); // the popup can say "You've read up to chapter 23"
    const pr = await sw.evaluate((id) => self.shiori.handlers.pin({ tabId: id }), rdTab);
    const seenEntry = await sw.evaluate(async (id) => self.shiori.store.getEntry(id), pr.id);
    assert.equal(seenEntry.progress.chap, 23);
    assert.equal(seenEntry.progress.slug, 'e2e-seen-chapter-23');
    // after pinning, those 23 chapters count as pinned: both totals now agree
    await app.click('#folderTabs button[data-folder=""]'); // leave Stats so it re-renders
    const [pinnedAfter, allAfter] = await statNums();
    assert.equal(pinnedAfter, pinnedCh + 23);
    assert.equal(allAfter, pinnedAfter);
    await app.click('#folderTabs button[data-folder=""]');
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

  await t.test('moving a series to another site keeps progress and folder, shows the new site', async () => {
    await app.click('#folderTabs button[data-folder=""]');
    await app.click('#grid .tile >> nth=0');
    await app.waitForSelector('dialog#edit[open]');
    const title = await app.textContent('#edit .ed-title');
    const progress = await app.textContent('#edit .ed-progress .num');
    const folder = await app.textContent('#edit .line .chip >> nth=1');
    await app.click('#edit .edit-toggle');
    await app.fill('#edit input[aria-label="Address of the series on the new site"]', 'https://manga.example.org/series/moved-here/');
    await app.click('#edit button:text-is("Move")');
    await app.waitForFunction(() => document.querySelector('#edit .chip.site')?.textContent === 'manga.example.org');
    assert.equal(await app.textContent('#edit .ed-title'), title);
    assert.equal(await app.textContent('#edit .ed-progress .num'), progress);
    assert.equal(await app.textContent('#edit .line .chip >> nth=1'), folder);
    await app.keyboard.press('Escape');
  });

  await t.test('a series without a cover gets one uploaded from a file', async () => {
    await app.click('#folderTabs button[data-folder=""]');
    await app.click('#grid .tile >> nth=0');
    await app.waitForSelector('dialog#edit[open]');
    const id = await app.$eval('#edit .ed-title', (el) => el.textContent);
    const png = Buffer.from(await app.evaluate(async () => {
      const c = new OffscreenCanvas(300, 420); const g = c.getContext('2d'); g.fillStyle = '#884422'; g.fillRect(0, 0, 300, 420);
      return [...new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer())];
    }));
    await app.click('#edit .edit-toggle');
    await app.setInputFiles('#edit input[type=file]', { name: 'cover.png', mimeType: 'image/png', buffer: png });
    await app.waitForFunction((t) => document.querySelector('dialog#edit[open] .ed-title')?.textContent === t && !document.querySelector('#edit').classList.contains('editing'), id);
    await app.waitForSelector('dialog#edit[open] .ed-cover img.cover');
    await app.keyboard.press('Escape');

    // "Find cover" for the comix series pinned earlier: its page's embedded poster, served locally
    await ctx.route('https://comix.to/images/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: png }));
    const comixId = await sw.evaluate(async () => [...(await self.shiori.store.loadLibrary()).entries.values()].find((e) => e.siteId === 'comix' && e.slug.startsWith('1j7n'))?.id);
    assert.ok(comixId, 'the comix series pinned earlier');
    const before = await sw.evaluate(async (i) => (await self.shiori.store.getEntry(i)).img, comixId);
    const r = await sw.evaluate((i) => self.shiori.handlers.findCover({ id: i }), comixId);
    const after = await sw.evaluate(async (i) => (await self.shiori.store.getEntry(i)).img, comixId);
    assert.match(after, /^local:\d+:[0-9a-f]{32}\.webp$/);
    assert.equal(after, r.key);
    assert.notEqual(after, before);
  });

  await t.test('the reading log counted the chapters read in this session', async () => {
    await app.click('#openSettings'); await app.click('#menu button[data-tab=stats]');
    await app.waitForSelector('.wk-col');
    assert.equal(await app.locator('.wk-col').count(), 12);
    const today = Number((await statValue('Today')).replace(/\D/g, ''));
    assert.ok(today >= 1, `today shows ${today}`);
    await app.click('#folderTabs button[data-folder=""]');
  });

  await t.test('no console errors on extension pages', () => {
    assert.deepEqual(consoleErrors.filter((e) => !/net::ERR_|Failed to load resource/.test(e)), []);
  });
});
