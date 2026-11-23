// Shiori background: the only place that does network I/O or writes the library.
// Chrome: MV3 service worker. Firefox 128+: event page (background.scripts). Both ES modules.

import { Store } from './lib/store.js';
import { WebDav } from './lib/webdav.js';
import { syncOnce } from './lib/sync.js';
import { planImport, exportString, editEntry, setProgress, deleteEntry, addEntry, newId, findBySeries, isUnread } from './lib/library.js';
import { exportFileName, ENTRY_FIELD_ORDER } from './lib/mangapin.js';
import { makeCover, fetchImage } from './lib/cover.js';
import { locate, trackVisit } from './lib/tracker.js';
import { applyChapters, fetchChapters, dueEntries, isBlockedPage } from './lib/releases.js';
import { seriesUrl, chapterUrl, getAdapter, siteName } from './lib/adapters.js';
import { mergeLabels } from './lib/merge.js';

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
  })().finally(() => { syncRunning = null; });
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
    if (id) await store.saveLibrary(lib);
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
  if (releasesRunning) return releasesRunning;
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
  return { h1, ogTitle: meta('meta[property="og:title"]'), title: document.title, imgs: [...new Set(imgs)].slice(0, 6) };
}

/** Runs inside the page: fetch an image with the page's referrer/cookies; returns a data URL. */
async function fetchInPage(url) {
  const res = await fetch(url, { credentials: 'include' });
  const blob = await res.blob();
  return await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(blob); });
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
  if (match && match.siteId) { siteId = match.siteId; slug = match.slug; }
  else {
    // generic site: like MangaPin's local sites, the slug is the series path on that host
    const u = new URL(tab.url);
    siteId = u.hostname;
    slug = u.pathname.replace(/(?:\/|-)(?:chapter|chap|ch|episode|ep)[-_ .]?\d[^/]*\/?$/i, '').replace(/\/+$/, '') || '/';
  }
  let scraped = { h1: '', ogTitle: '', title: tab.title || '', imgs: [] };
  try {
    const [res] = await api.scripting.executeScript({ target: { tabId }, func: scrapePage });
    if (res && res.result) scraped = res.result;
  } catch (e) { console.warn('[shiori pin] scrape failed', e && e.message); }

  let cover = null;
  for (const src of scraped.imgs || []) {
    try { cover = await makeCover(await fetchImage(src)); break; } catch { /* try next */ }
    try {
      const [r] = await api.scripting.executeScript({ target: { tabId }, func: fetchInPage, args: [src] });
      if (r && typeof r.result === 'string') { cover = await makeCover(await (await fetch(r.result)).blob()); break; }
    } catch { /* try next */ }
  }
  const now = Date.now();
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
      progress: match && match.kind === 'chapter' && typeof match.chap === 'number'
        ? (match.chapSlug ? { chap: match.chap, slug: match.chapSlug, ts: now } : { chap: match.chap, ts: now }) : undefined,
      cLang: 'en', folder: Number(folder) || 1, tags: [], ts: now, createTs: now, id: newId(new Set(lib.entries.keys())),
    };
    for (const k of ENTRY_FIELD_ORDER) if (fields[k] !== undefined) e[k] = fields[k];
    if (cover) await store.putCovers([[cover.key, cover.b64]]);
    addEntry(lib, e, now);
    await store.saveLibrary(lib);
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
    return { url: tab.url, title: tab.title, entry, match, site: match ? siteName(match.siteId) : null };
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
  async importFile({ text, mode, apply }) {
    return store.withLock(async () => {
      const lib = await store.loadLibrary();
      const plan = planImport(lib, new Set(await store.coverKeys()), text, mode === 'replace' ? 'replace' : 'merge');
      if (apply) {
        await store.putCovers(plan.covers);
        await store.saveLibrary(plan.lib);
      }
      return { summary: plan.summary, applied: !!apply };
    });
  },
  async exportFile() {
    const lib = await store.loadLibrary();
    const covers = await store.getCovers(await store.coverKeys());
    return { name: exportFileName(), text: exportString(lib, (k) => covers.get(k)) };
  },
  async saveSettings({ cfg, token }) {
    const next = await store.setConfig(cfg || {});
    if (typeof token === 'string' && token) await store.setToken(token);
    if (token === null) await store.setToken('');
    await store.setSyncState({ dirsOk: false, etag: null });
    return { cfg: next };
  },
  async testConnection({ cfg, token }) {
    const saved = await store.getConfig();
    const tok = token || (await store.getToken());
    try {
      const dav = new WebDav({ url: (cfg && cfg.davUrl) || saved.davUrl, user: (cfg && cfg.user) || saved.user, token: tok });
      const root = await dav.propfind('', 0);
      if (!root) return { ok: false, error: 'WebDAV root not found (404) — check the URL' };
      const lib = await dav.head('Shiori/library.json');
      return { ok: true, message: lib ? 'Connected. Shiori/library.json exists on the server.' : 'Connected. No library on the server yet — the first sync will create Shiori/.' };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  },
  async syncNow() { return runSync('manual'); },
  async checkReleases({ ids, force = true }) { return runReleaseChecks({ ids, force }); },
  async saveLabels({ labels }) {
    return store.withLock(async () => {
      const lib = await store.loadLibrary();
      const now = Date.now();
      const next = { folder: {}, type: {}, tag: {} };
      for (const kind of Object.keys(next)) {
        for (const [k, name] of Object.entries((labels && labels[kind]) || {})) {
          if (!/^-?\d+$/.test(k)) continue;
          const old = lib.labels?.[kind]?.[k];
          const n = String(name || '').slice(0, 60);
          next[kind][k] = old && old.name === n ? old : { name: n, ts: now };
        }
        // removed labels become empty names so the removal syncs
        for (const k of Object.keys(lib.labels?.[kind] || {})) if (!(k in next[kind])) next[kind][k] = { name: '', ts: now };
      }
      lib.labels = mergeLabels(next, { folder: {}, type: {}, tag: {} });
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
