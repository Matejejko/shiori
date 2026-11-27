// Shiori background: the only place that does network I/O or writes the library.
// Chrome: MV3 service worker. Firefox 128+: event page (background.scripts). Both ES modules.

import { Store } from './lib/store.js';
import { WebDav, findDavRoot } from './lib/webdav.js';
import { tagIdsFromNames } from './lib/labels.js';
import { syncOnce } from './lib/sync.js';
import { planImport, exportBackup, editEntry, setProgress, deleteEntry, addEntry, newId, findBySeries, isUnread, moveEntry, countRead } from './lib/library.js';
import { exportFileName, ENTRY_FIELD_ORDER } from './lib/mangapin.js';
import { makeCover, fetchImage } from './lib/cover.js';
import { locate, trackVisit, seriesOf, seenFor, noteSeen } from './lib/tracker.js';
import { applyChapters, fetchChapters, dueEntries, isBlockedPage } from './lib/releases.js';
import { seriesUrl, chapterUrl, getAdapter, siteName, matchUrl } from './lib/adapters.js';

const api = globalThis.browser ?? globalThis.chrome;
const store = new Store(api.storage.local);

const SYNC_DEBOUNCE_MS = 5000;
const SYNC_PERIOD_MIN = 15;
const RELEASE_TICK_MIN = 30; // due entries (last checked > 6h ago) are checked on each tick
const HOST_GAP_MS = 1500;    // politeness delay between requests to the same site

// ---------------------------------------------------------------------------------------
// alarms + lifecycle

async function ensureAlarms() {
  const want = { sync: SYNC_PERIOD_MIN, releases: RELEASE_TICK_MIN };
  for (const [name, period] of Object.entries(want)) {
    const a = await api.alarms.get(name);
    if (!a || a.periodInMinutes !== period) api.alarms.create(name, { periodInMinutes: period, delayInMinutes: 1 });
  }
}
api.runtime.onInstalled.addListener(() => { ensureAlarms(); updateBadge(); });
api.runtime.onStartup.addListener(() => { ensureAlarms(); updateBadge(); scheduleSync(SYNC_DEBOUNCE_MS); });
ensureAlarms();
store.setSyncState({ running: false }); // a worker killed mid-sync must not leave "Syncing…" forever

api.alarms.onAlarm.addListener((a) => {
  if (a.name === 'sync') runSync('alarm');
  else if (a.name === 'releases') runReleaseChecks({});
  else if (a.name === 'sync-debounce') runSync('debounce');
});

// ---------------------------------------------------------------------------------------
// change notifications -> debounced sync + badge

let debounceTimer = null;
function scheduleSync(ms = SYNC_DEBOUNCE_MS) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runSync('change'), ms);
  // backstop in case the worker is suspended before the timer fires (alarms have a 30s floor)
  api.alarms.create('sync-debounce', { delayInMinutes: 0.5 });
}
store.onChange = (what) => {
  updateBadge();
  if (what === 'library') scheduleSync();
  broadcast({ type: 'changed', what });
};

function broadcast(msg) {
  try { api.runtime.sendMessage(msg).catch(() => {}); } catch { /* no listeners */ }
}

async function updateBadge() {
  try {
    const lib = await store.loadLibrary();
    const cfg = await store.getConfig();
    let n = 0;
    for (const e of lib.entries.values()) if (e.folder === cfg.releaseFolder && isUnread(e)) n++;
    await api.action.setBadgeText({ text: n ? String(n) : '' });
    await api.action.setBadgeBackgroundColor({ color: '#c2410c' });
  } catch { /* badge is cosmetic */ }
}

// ---------------------------------------------------------------------------------------
// sync

let syncRunning = null;
async function davFromSettings() {
  const cfg = await store.getConfig();
  const token = await store.getToken();
  if (!cfg.davUrl || !cfg.user || !token) return null;
  return new WebDav({ url: cfg.davUrl, user: cfg.user, token });
}

function runSync(reason) {
  if (syncRunning) return syncRunning;
  syncRunning = (async () => {
    const cfg = await store.getConfig();
    if (reason !== 'manual' && !cfg.autoSync) return { skipped: 'auto sync off' };
    const dav = await davFromSettings();
    if (!dav) return { skipped: 'not configured' };
    await store.setSyncState({ lastAttempt: Date.now(), running: true });
    broadcast({ type: 'sync', running: true });
    try {
      const stats = await syncOnce({ store, dav, log: (s) => console.info('[shiori sync]', s) });
      await store.setSyncState({ running: false });
      return { ok: true, stats };
    } catch (err) {
      const msg = String(err && err.message || err);
      await store.setSyncState({ lastError: msg, running: false });
      console.warn('[shiori sync] failed:', msg);
      return { ok: false, error: msg };
    } finally {
      broadcast({ type: 'sync', running: false });
      updateBadge();
    }
  })().finally(async () => {
    syncRunning = null;
    // edits made while this sync ran were not in it: don't leave them for the 15-min alarm
    if ((await store.getSyncState()).dirty && (await davFromSettings())) scheduleSync();
  });
  return syncRunning;
}

// ---------------------------------------------------------------------------------------
// tracking

const lastSeen = new Map(); // tabId -> url (skip duplicate onUpdated events)
api.tabs.onUpdated.addListener((tabId, change, tab) => {
  const url = change.url || (change.status === 'complete' ? tab.url : null);
  if (!url || !/^https?:/.test(url) || lastSeen.get(tabId) === url) return;
  lastSeen.set(tabId, url);
  store.withLock(async () => {
    const lib = await store.loadLibrary();
    const id = trackVisit(lib, url);
    if (id) {
      countRead(lib, await store.deviceId());
      await store.saveLibrary(lib);
    } else if (!locate(lib, url).entry) {
      // not pinned (yet): remember how far you read, so pinning later starts there
      if (noteSeen(lib.seen, url)) {
        // the reading log counts it too, but only on known manga sites (a "chapter-3" path
        // on any other site is not reading)
        if (!seriesOf(url)?.generic) countRead(lib, await store.deviceId());
        await store.saveLibrary(lib);
      }
    }
  }).catch((e) => console.warn('[shiori track]', e));
});
api.tabs.onRemoved.addListener((tabId) => lastSeen.delete(tabId));

// ---------------------------------------------------------------------------------------
// release checks

let releasesRunning = null;
const lastHit = new Map(); // host -> ts
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(req) {
  const host = new URL(req.url).host;
  const wait = (lastHit.get(host) || 0) + HOST_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(req.url, { method: req.method || 'GET', headers: req.headers, body: req.body, credentials: 'omit', signal: ctrl.signal });
    const text = await res.text();
    if (isBlockedPage(text)) throw new Error(`${host} answered with a bot challenge (Cloudflare) — open the site once in a tab, or check manually`);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`);
    return text;
  } finally { clearTimeout(t); }
}

async function checkOne(entry) {
  const { chapters, complete } = await fetchChapters(entry, fetchText);
  if (!chapters.length) throw new Error('no chapters found (site layout changed or page blocked?)');
  return store.withLock(async () => {
    const lib = await store.loadLibrary();
    const cur = lib.entries.get(entry.id);
    if (!cur) return { id: entry.id, changed: false };
    const next = applyChapters(cur, chapters, Date.now(), { complete });
    if (next) { lib.entries.set(entry.id, next); await store.saveLibrary(lib); }
    return { id: entry.id, changed: !!next, chapters: chapters.length };
  });
}

function runReleaseChecks({ ids = null, force = false }) {
  if (releasesRunning) return ids ? releasesRunning.then(() => runReleaseChecks({ ids, force })) : releasesRunning;
  releasesRunning = (async () => {
    const cfg = await store.getConfig();
    if (!cfg.releaseChecks && !force) return { skipped: true };
    const { relchk = {} } = await api.storage.local.get('relchk');
    const lib = await store.loadLibrary();
    const due = ids
      ? ids.map((id) => lib.entries.get(id)).filter((e) => e && getAdapter(e.siteId)?.list)
      : dueEntries(lib, { folder: cfg.releaseFolder, checked: relchk, interval: force ? 0 : undefined });
    const results = [];
    for (const e of due) {
      let r;
      try { r = await checkOne(e); } catch (err) { r = { id: e.id, error: String(err.message || err) }; }
      results.push(r);
      relchk[e.id] = Date.now();
      const errs = (await api.storage.local.get('relerr')).relerr || {};
      if (r.error) errs[e.id] = { at: Date.now(), error: r.error }; else delete errs[e.id];
      await api.storage.local.set({ relchk, relerr: errs }); // persisted per entry: a killed worker resumes next tick
    }
    updateBadge();
    return { checked: results.length, changed: results.filter((r) => r.changed).length, errors: results.filter((r) => r.error) };
  })().finally(() => { releasesRunning = null; });
  return releasesRunning;
}

// ---------------------------------------------------------------------------------------
// pinning

/** Runs inside the page: read title + cover candidates. Returns plain strings only. */
function scrapePage() {
  const meta = (sel) => document.querySelector(sel)?.getAttribute('content') || '';
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return ''; } };
  const h1 = document.querySelector('h1')?.textContent?.trim() || '';
  const imgs = [];
  const og = meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]');
  if (og) imgs.push(abs(og));
  for (const sel of ['.poster img', '.thumb img', '.summary_image img', 'img.wp-post-image', '[class*="cover"] img', 'main img']) {
    const el = document.querySelector(sel);
    const src = el && (el.getAttribute('data-src') || el.getAttribute('src'));
    if (src && !src.startsWith('data:')) imgs.push(abs(src));
  }
  // genre links, with MangaPin's per-site selectors; menus/headers excluded (site-wide genre lists)
  const genreSel = '.mgen a, .genres-content a, .genre-tag, a[href*="?genres_in="], a[href*="/browse?genres="], a[href*="?tag="], a[href*="/tag/"], a[href*="search?genres="], a[href*="/genres/"]';
  let genres = [...document.querySelectorAll(genreSel)]
    .filter((el) => !el.closest('nav, header, footer, [role="navigation"], .menu'))
    .map((el) => el.textContent.trim()).filter((t) => t && t.length < 40);
  if (genres.length > 80) genres = []; // a site-wide genre list slipped through
  // embedded data: Comix ships genres/formats/tags as JSON (no links); many sites carry schema.org "genre"
  const json = (el) => { try { return el ? JSON.parse(el.textContent) : null; } catch { return null; } };
  const init = json(document.querySelector('script#initial-data'));
  for (const [k, q] of Object.entries(init?.queries || {})) {
    if (!k.includes('"detail"')) continue; // only this series, not recommendations
    for (const f of ['genres', 'demographics', 'formats', 'tags']) for (const g of Array.isArray(q?.[f]) ? q[f] : []) if (g && g.title) genres.push(String(g.title));
  }
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    const d = json(el);
    for (const o of [d, ...(Array.isArray(d?.['@graph']) ? d['@graph'] : [])].flat()) {
      if (o && o.genre) genres.push(...[o.genre].flat().map(String));
    }
  }
  return { h1, ogTitle: meta('meta[property="og:title"]'), title: document.title, imgs: [...new Set(imgs)].slice(0, 6), genres };
}

/** Page title -> series name: drop "Read … Online", "- Arenascans"-style site suffixes. */
export function cleanName(s, hostname = '') {
  let n = String(s || '').replace(/\s+/g, ' ').trim();
  n = n.replace(/^read\s+/i, '').replace(/\s*[|–—-]\s*(read|manga|manhwa|manhua|comic|webtoon|scans?)\b.*$/i, '');
  n = n.replace(/\s+(manga|manhwa|manhua)\s*(\[latest chapters\]|online)?$/i, '').replace(/\s*\[latest chapters\]$/i, '');
  const label = hostname.toLowerCase().replace(/^www\./, '').split('.')[0].replace(/[^a-z0-9]/g, '');
  const m = /^(.*\S)\s+[|–—-]\s+([^|–—-]+)$/.exec(n);
  if (m && label.length >= 4) {
    const suffix = m[2].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (suffix && (suffix.startsWith(label) || label.startsWith(suffix))) n = m[1];
  }
  return n.trim().slice(0, 300);
}

async function pinTab(tabId, { name: nameOverride, folder = 1 } = {}) {
  const tab = await api.tabs.get(tabId);
  const lib0 = await store.loadLibrary();
  const { entry, match } = locate(lib0, tab.url);
  if (entry) return { already: true, id: entry.id };
  let siteId, slug;
  if (match && match.siteId && !match.slug) throw new Error('This page is not a series or chapter page.');
  if (match && match.siteId) { siteId = match.siteId; slug = match.slug; }
  else ({ siteId, slug } = seriesOf(tab.url)); // generic site: the series path on that host
  let scraped = { h1: '', ogTitle: '', title: tab.title || '', imgs: [] };
  try {
    const [res] = await api.scripting.executeScript({ target: { tabId }, func: scrapePage });
    if (res && res.result) scraped = res.result;
  } catch (e) { console.warn('[shiori pin] scrape failed', e && e.message); }

  let cover = null;
  for (const src of scraped.imgs || []) {
    // shortcut: CDNs that require the page as Referer give no cover (the background cannot send one); pin then has no cover
    try { cover = await makeCover(await fetchImage(src)); break; } catch { /* try next */ }
  }
  const now = Date.now();
  // furthest of: the chapter on this page, the chapters you read before pinning
  const here = seriesOf(tab.url);
  const before = seenFor(lib0.seen, siteId, slug);
  const page = here && typeof here.chap === 'number' ? { chap: here.chap, slug: here.generic ? undefined : here.chapSlug } : null;
  const readSoFar = [page, before].filter(Boolean).sort((a, b) => b.chap - a.chap)[0] || null;
  return store.withLock(async () => {
    const lib = await store.loadLibrary();
    const dup = findBySeries(lib, siteId, slug);
    if (dup) return { already: true, id: dup.id };
    const e = {};
    const fields = {
      siteId, slug,
      url: match && match.kind === 'series' ? tab.url.split('#')[0] : seriesUrl({ siteId, slug }) || undefined,
      name: cleanName(nameOverride || scraped.h1 || scraped.ogTitle || scraped.title, new URL(tab.url).hostname) || slug,
      img: cover ? cover.key : undefined,
      progress: readSoFar ? (readSoFar.slug ? { chap: readSoFar.chap, slug: readSoFar.slug, ts: now } : { chap: readSoFar.chap, ts: now }) : undefined,
      cLang: 'en', folder: Number(folder) || 1, tags: tagIdsFromNames(scraped.genres || []), ts: now, createTs: now, id: newId(new Set([...lib.entries.keys(), ...lib.tombs.keys()])) /* a deleted id stays deleted */,
    };
    for (const k of ENTRY_FIELD_ORDER) if (fields[k] !== undefined) e[k] = fields[k];
    if (cover) await store.putCovers([[cover.key, cover.b64]]);
    addEntry(lib, e, now);
    await store.saveLibrary(lib);
    // look up its chapters right away instead of waiting for the 6-hourly check
    if (getAdapter(siteId)?.list) setTimeout(() => runReleaseChecks({ ids: [e.id], force: true }).catch(() => {}), 0);
    return { pinned: true, id: e.id, cover: !!cover };
  });
}

// ---------------------------------------------------------------------------------------
// messages from popup / app page

const handlers = {
  async state() {
    const [cfg, token, sync, lib, coverKeys] = await Promise.all([store.getConfig(), store.getToken(), store.getSyncState(), store.loadLibrary(), store.coverKeys()]);
    return { cfg, hasToken: !!token, sync: { ...sync, remoteCovers: undefined }, count: lib.entries.size, covers: coverKeys.length };
  },
  async currentTab({ tabId }) {
    const tab = await api.tabs.get(tabId);
    const lib = await store.loadLibrary();
    const { entry, match } = locate(lib, tab.url || '');
    let seen = null;
    if (!entry) {
      const s = seriesOf(tab.url || '');
      if (s) seen = seenFor(lib.seen, s.siteId, s.slug);
    }
    return { url: tab.url, title: tab.title, entry, match, seen, site: match ? siteName(match.siteId) : null };
  },
  async pin({ tabId, name, folder }) { return pinTab(tabId, { name, folder }); },
  async setProgress({ id, chap, manual = true }) {
    return store.withLock(async () => {
      const lib = await store.loadLibrary();
      const ok = setProgress(lib, id, Number(chap), { manual });
      if (ok) await store.saveLibrary(lib);
      return { ok };
    });
  },
  async edit({ id, patch }) {
    return store.withLock(async () => {
      const lib = await store.loadLibrary();
      const clean = {};
      for (const [k, v] of Object.entries(patch || {})) {
        if (k === 'name' && typeof v === 'string') clean.name = v.slice(0, 300);
        else if (k === 'url') clean.url = v ? String(v) : undefined;
        else if (k === 'folder' || k === 'type' || k === 'score') clean[k] = v === '' || v === null || v === undefined ? undefined : Number(v);
        else if (k === 'tags' && Array.isArray(v)) clean.tags = v.map(Number).filter(Number.isFinite);
        else if (k === 'startTs' || k === 'endTs') clean[k] = v ? Number(v) : undefined;
      }
      if (clean.folder === undefined && 'folder' in clean) delete clean.folder; // folder is required by MangaPin
      if ('url' in clean && clean.url !== undefined && !/^https?:\/\//i.test(clean.url)) throw new Error('URL must be http(s)');
      const cur = lib.entries.get(id);
      if (!cur) throw new Error('no such entry');
      // only real changes: an untouched "Save" must not bump ts or alter the entry's bytes
      for (const k of Object.keys(clean)) if (JSON.stringify(cur[k]) === JSON.stringify(clean[k])) delete clean[k];
      if (!Object.keys(clean).length) return { ok: true, unchanged: true };
      editEntry(lib, id, clean);
      await store.saveLibrary(lib);
      return { ok: true };
    });
  },
  async move({ id, url }) {
    let u;
    try { u = new URL(String(url || '').trim()); } catch { throw new Error('Paste the full address of the series on the new site.'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('The address must start with http(s)://');
    // same rules as pinning: a known site's series or chapter page, else the path on that host
    const s = seriesOf(u.href);
    if (!s || s.slug === '/') throw new Error('That page is not a series or chapter page.');
    const { siteId, slug } = s;
    const match = matchUrl(u.href);
    const pageUrl = match && match.kind === 'series' ? u.href.split('#')[0] : seriesUrl({ siteId, slug }) || undefined;
    const newId = await store.withLock(async () => {
      const lib = await store.loadLibrary();
      const nid = moveEntry(lib, id, { siteId, slug, url: pageUrl });
      await store.saveLibrary(lib);
      return nid;
    });
    if (getAdapter(siteId)?.list) runReleaseChecks({ ids: [newId], force: true }).catch(() => {});
    return { id: newId, siteId };
  },
  async remove({ id }) {
    return store.withLock(async () => {
      const lib = await store.loadLibrary();
      const ok = deleteEntry(lib, id);
      if (ok) await store.saveLibrary(lib);
      return { ok };
    });
  },
  async library() {
    const lib = await store.loadLibrary();
    const { relerr = {} } = await api.storage.local.get('relerr');
    return {
      entries: lib.order.map((id) => lib.entries.get(id)),
      labels: lib.labels,
      days: lib.days,
      seen: lib.seen,
      relerr,
      urls: Object.fromEntries(lib.order.map((id) => {
        const e = lib.entries.get(id);
        const next = e.next && (!e.progress || e.next.chap > e.progress.chap) ? e.next : null;
        return [id, { series: e.url || seriesUrl(e, { link: true }), next: next ? chapterUrl(e, next) : null }];
      })),
    };
  },
  async covers({ keys }) {
    const m = await store.getCovers(keys || []);
    return Object.fromEntries(m);
  },
  async importFile({ text, mode, source, apply, planId }) {
    mode = mode === 'replace' ? 'replace' : 'merge';
    source = source === 'mangapin' ? 'mangapin' : 'shiori';
    // Replace decides which series exist on every device: pull the server first so series
    // that so far only exist elsewhere are in the plan (and get deleted, not resurrected).
    let syncWarning = '';
    if (mode === 'replace' && (await davFromSettings())) {
      const r = await runSync('manual');
      if (r && r.ok === false) syncWarning = `Could not sync first (${r.error}): series that exist only on your other devices will not be removed.`;
    }
    return store.withLock(async () => {
      const lib = await store.loadLibrary();
      const plan = planImport(lib, new Set(await store.coverKeys()), text, mode, Date.now(), source);
      plan.summary.syncWarning = syncWarning;
      if (apply) {
        if (planId && planId !== plan.summary.planId) throw new Error('PLAN_CHANGED: your library changed since the dry run (a sync ran). Review the new summary.');
        // the push after a replace overwrites the server's library: keep its current copy first
        if (mode === 'replace') await store.setSyncState({ snapNext: true });
        await store.putCovers(plan.covers);
        await store.saveLibrary(plan.lib);
      }
      return { summary: plan.summary, applied: !!apply };
    });
  },
  async exportFile() {
    const lib = await store.loadLibrary();
    const covers = await store.getCovers(await store.coverKeys());
    return { name: exportFileName(), text: exportBackup(lib, (k) => covers.get(k)) };
  },
  async saveSettings({ cfg, token }) {
    cfg = { ...(cfg || {}) };
    // a bare server address: store the WebDAV folder it actually serves (when the server says so)
    const tok = token || (await store.getToken());
    if (cfg.davUrl && tok && /^https?:\/\/[^/]+\/?$/i.test(cfg.davUrl)) {
      try { cfg.davUrl = await findDavRoot({ url: cfg.davUrl, user: cfg.user, token: tok }); } catch { /* saved as typed; Test connection explains */ }
    }
    const next = await store.setConfig(cfg);
    if (typeof token === 'string' && token) await store.setToken(token);
    if (token === null) await store.setToken('');
    await store.setSyncState({ dirsOk: false, etag: null });
    return { cfg: next };
  },
  async testConnection({ cfg, token }) {
    const saved = await store.getConfig();
    const url = (cfg && cfg.davUrl) || saved.davUrl;
    const origin = (u) => { try { return new URL(u).origin; } catch { return null; } };
    if (!token && origin(url) !== origin(saved.davUrl)) return { ok: false, error: 'Enter the app token to test a different server (the saved one is only sent to the saved server).' };
    const tok = token || (await store.getToken());
    try {
      const user = (cfg && cfg.user) || saved.user;
      const found = await findDavRoot({ url, user, token: tok });
      const dav = new WebDav({ url: found, user, token: tok });
      const lib = await dav.head('Shiori/library.json');
      const where = found !== new URL(url).href ? ` WebDAV folder: ${found} — Save to keep it.` : '';
      return { ok: true, davUrl: found, message: (lib ? 'Connected. Shiori/library.json exists on the server.' : 'Connected. No library on the server yet — the first sync will create Shiori/.') + where };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  },
  async syncNow() { return runSync('manual'); },
  async checkReleases({ ids, force = true }) { return runReleaseChecks({ ids, force }); },
  async saveLabels({ labels, base = {} }) {
    return store.withLock(async () => {
      const lib = await store.loadLibrary();
      const now = Date.now();
      const next = structuredClone(lib.labels || { folder: {}, type: {}, tag: {} });
      for (const kind of ['folder', 'type', 'tag']) {
        const want = (labels && labels[kind]) || {}, was = (base && base[kind]) || {};
        next[kind] ||= {};
        // only what the user changed in the form; untouched rows keep whatever synced meanwhile
        for (const k of new Set([...Object.keys(want), ...Object.keys(was)])) {
          if (!/^-?\d+$/.test(k)) continue;
          const n = String(want[k] ?? '').slice(0, 60);
          if (n === (was[k] ?? '')) continue;
          next[kind][k] = { name: n, ts: now }; // '' = removed (syncs as a removal)
        }
      }
      lib.labels = next;
      await store.saveLibrary(lib);
      return { ok: true };
    });
  },
};

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // only our own extension pages may talk to the background
  if (sender.id !== api.runtime.id || (sender.url && !sender.url.startsWith(api.runtime.getURL('')))) return false;
  const h = msg && handlers[msg.type];
  if (!h) return false;
  Promise.resolve().then(() => h(msg)).then(
    (r) => sendResponse({ ok: true, result: r }),
    (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }),
  );
  return true; // async response
});

// debugging / e2e hooks (service-worker global only; not reachable from web pages)
globalThis.shiori = { store, runSync, runReleaseChecks, handlers };
