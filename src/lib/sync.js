// Sync: /Shiori/library.json via GET -> merge -> conditional PUT, retry on 412.
// Covers are content-addressed files /Shiori/covers/<bytes>-<md5>.webp, uploaded once.

import { mergeLibraries, libraryFingerprint, metaOf, emptyLabels } from './merge.js';
import { neededCoverKeys } from './library.js';
import { coverKeyToFile, coverFileToKey, parseCoverKey, verifyCover } from './mangapin.js';
import { md5 } from './md5.js';
import { b64ToBytes, bytesToB64 } from './base64.js';
import { DavError } from './webdav.js';

export const REMOTE_DIR = 'Shiori';
const FORMAT = 'shiori-library';
const pathsFor = (dir = REMOTE_DIR) => ({ DIR: dir, DOC: `${dir}/library.json`, COVERS: `${dir}/covers` });

const sortObj = (m) => Object.fromEntries([...m].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));

/** Library -> library.json text. Entries stay verbatim (their own key order). */
export function toDoc(lib, now = Date.now()) {
  const order = lib.order.filter((id) => lib.entries.has(id));
  return JSON.stringify({
    format: FORMAT,
    version: 1,
    updated: now,
    entries: order.map((id) => lib.entries.get(id)),
    meta: sortObj(new Map(order.map((id) => [id, metaOf(lib.entries.get(id), lib.meta.get(id))]))),
    tombs: sortObj(lib.tombs),
    labels: lib.labels || emptyLabels(),
    top: lib.top || null,
    keepImgs: lib.keepImgs || [],
    layoutTs: lib.layoutTs || 0,
  });
}

export function fromDoc(text) {
  let d;
  try { d = JSON.parse(text); } catch { throw new DavError('library.json on the server is not valid JSON — refusing to overwrite it', 0, 'format'); }
  if (!d || d.format !== FORMAT || !Array.isArray(d.entries)) {
    throw new DavError('library.json on the server is not a Shiori library — refusing to overwrite it', 0, 'format');
  }
  const entries = new Map(), meta = new Map(), order = [];
  for (const e of d.entries) {
    if (!e || typeof e.id !== 'string') continue;
    if (!entries.has(e.id)) order.push(e.id);
    entries.set(e.id, e);
    if (d.meta && d.meta[e.id]) meta.set(e.id, d.meta[e.id]);
  }
  return {
    order, entries, meta,
    tombs: new Map(Object.entries(d.tombs || {}).filter(([, t]) => typeof t === 'number')),
    labels: d.labels || emptyLabels(),
    top: d.top || null,
    keepImgs: Array.isArray(d.keepImgs) ? d.keepImgs : [],
    layoutTs: typeof d.layoutTs === 'number' ? d.layoutTs : 0,
  };
}

const sameContent = (a, b) => libraryFingerprint(a) === libraryFingerprint(b)
  && JSON.stringify(a.order) === JSON.stringify(b.order)
  && JSON.stringify(a.top || null) === JSON.stringify(b.top || null)
  && JSON.stringify(a.keepImgs || []) === JSON.stringify(b.keepImgs || [])
  && (a.layoutTs || 0) === (b.layoutTs || 0);

/**
 * One sync round. Never throws for "nothing to do"; throws DavError on failure.
 * @param {{store: import('./store.js').Store, dav: import('./webdav.js').WebDav, now?: ()=>number, log?: (s:string)=>void}} o
 * @returns {Promise<{pushed:boolean, pulled:number, attempts:number, conflicts:number, coversUp:number, coversDown:number}>}
 */
export async function syncOnce({ store, dav, now = Date.now, log = () => {}, dir = REMOTE_DIR }) {
  const { DIR, DOC, COVERS } = pathsFor(dir);
  const state = await store.getSyncState();
  const seqAtStart = state.seq || 0;
  const stats = { pushed: false, pulled: 0, attempts: 0, conflicts: 0, coversUp: 0, coversDown: 0 };

  if (!state.dirsOk) {
    await dav.mkcol(DIR);
    await dav.mkcol(COVERS);
    await store.setSyncState({ dirsOk: true });
  }

  let merged;
  // Cheap no-op check: nothing changed locally and the server still has what we last saw.
  if (!state.dirty && state.etag) {
    const head = await dav.head(DOC);
    if (head && head.etag === state.etag) merged = await store.loadLibrary();
  }
  while (!merged) {
    stats.attempts++;
    if (stats.attempts > 6) throw new DavError('gave up after repeated 412 conflicts', 412, 'conflict');
    let remote;
    try {
      remote = await dav.getText(DOC);
    } catch (err) {
      if (err.status === 409) await store.setSyncState({ dirsOk: false });
      throw err;
    }
    const remoteLib = remote ? fromDoc(remote.text) : null;

    // merge + persist locally under the store lock (tracker/UI edits wait for us)
    const plan = await store.withLock(async () => {
      const local = await store.loadLibrary();
      const m = remoteLib ? mergeLibraries(remoteLib, local) : local;
      if (!sameContent(m, local)) stats.pulled = await store.saveLibrary(m, { silent: true });
      return { m, needPush: !remoteLib || !sameContent(m, remoteLib) };
    });
    if (!plan.needPush) { merged = plan.m; await store.setSyncState({ etag: remote.etag || null }); break; }

    const body = toDoc(plan.m, now());
    const cond = remote ? (remote.etag ? { ifMatch: remote.etag } : {}) : { ifNoneMatch: '*' };
    let res;
    try {
      res = await dav.put(DOC, body, { contentType: 'application/json', ...cond });
    } catch (err) {
      if (err.status === 412) { stats.conflicts++; log(`412 on PUT (attempt ${stats.attempts}), re-reading`); continue; }
      if (err.status === 409) await store.setSyncState({ dirsOk: false });
      throw err;
    }
    if (!remote) {
      // OpenCloud ignores If-None-Match:* (verified: it overwrites with 204), so two devices
      // creating library.json at the same moment would clobber each other. Read it back; if
      // it is not what we wrote, go round again and merge with the winner via If-Match.
      // (Any remaining overwrite is healed on the next sync: local data is never discarded.)
      const check = await dav.getText(DOC);
      if (!check || check.text !== body) { stats.conflicts++; log('first write was overwritten by another device, re-merging'); continue; }
      res.etag = check.etag;
    }
    stats.pushed = true;
    merged = plan.m;
    await store.setSyncState({ etag: res.etag || null });
  }

  // ---- covers ---------------------------------------------------------------------------
  const listing = await dav.propfind(COVERS + '/', 1);
  if (listing === null) { await store.setSyncState({ dirsOk: false }); throw new DavError('covers folder missing on server', 404); }
  const remoteFiles = new Set(listing.filter((x) => !x.self && !x.dir).map((x) => x.name));
  const needed = neededCoverKeys(merged);
  const localKeys = new Set(await store.coverKeys());

  for (const key of needed) {
    const file = coverKeyToFile(key);
    if (!file) continue; // not a local:<bytes>:<md5>.webp key (e.g. a plain URL) — nothing to sync
    if (localKeys.has(key) && !remoteFiles.has(file)) {
      const b64 = await store.getCover(key);
      if (!verifyCover(key, b64)) { log(`cover ${key} does not match its key — kept locally, not uploaded`); continue; }
      const bytes = b64ToBytes(b64);
      try {
        await dav.put(`${COVERS}/${file}`, bytes, { ifNoneMatch: '*', contentType: 'image/webp' });
      } catch (err) {
        if (err.status !== 412) throw err; // 412: someone uploaded it meanwhile — same content by construction
      }
      stats.coversUp++;
    } else if (!localKeys.has(key) && remoteFiles.has(file)) {
      const bytes = await dav.getBytes(`${COVERS}/${file}`);
      const p = parseCoverKey(key);
      if (bytes && bytes.length === p.bytes && md5(bytes) === p.md5) {
        await store.putCovers([[key, bytesToB64(bytes)]]);
        stats.coversDown++;
      } else {
        log(`cover ${file} on server does not match its name — ignored`);
      }
    }
  }
  // remember which covers the server has (lets the UI show "missing everywhere")
  const after = new Set(remoteFiles);
  for (const key of needed) if (localKeys.has(key)) after.add(coverKeyToFile(key));

  await store.setSyncState({
    lastOk: now(), lastError: '', lastStats: stats, syncedSeq: seqAtStart,
    remoteCovers: [...after].map(coverFileToKey).filter(Boolean),
  });
  return stats;
}
