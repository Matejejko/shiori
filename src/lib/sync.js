// Sync: /Shiori/library.json via GET -> merge -> conditional PUT, retry on 412.
// Covers are content-addressed files /Shiori/covers/<bytes>-<md5>.webp, uploaded once.

import { mergeLibraries, libraryFingerprint, metaOf, emptyLabels } from './merge.js';
import { coverKeyToFile, coverFileToKey, parseCoverKey, verifyCover, referencedImgKeys } from './mangapin.js';
import { md5 } from './md5.js';
import { b64ToBytes, bytesToB64 } from './base64.js';
import { DavError } from './webdav.js';
import { normalizeEntry } from './labels.js';

export const REMOTE_DIR = 'Shiori';
const FORMAT = 'shiori-library';
// Bump when library.json changes shape (and teach libFromDoc the old one). A device that meets a
// newer version stops syncing instead of rewriting the file in a shape it doesn't understand.
// 2: tags are names (1: MangaPin tag numbers, converted when read); labels are folder names only.
export const LIB_VERSION = 2;
const pathsFor = (dir = REMOTE_DIR) => ({ DIR: dir, DOC: `${dir}/library.json`, COVERS: `${dir}/covers`, BACKUPS: `${dir}/backups` });
// Server-side snapshots of library.json (the undo for a final delete or a wrong replace import):
// the server's copy is saved before the first overwrite of each day and before the push that
// follows a replace import; the newest KEEP_SNAPSHOTS stay. Covers on the server are never
// deleted, so a snapshot + /covers is a complete restore (Import -> Replace with the snapshot).
export const KEEP_SNAPSHOTS = 14;
const SNAP_RE = /^library-[0-9T:-]+(-before-import)?\.json$/;

const sortObj = (m) => Object.fromEntries([...m].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));

/** Library -> library.json object. Entries stay verbatim (their own key order). */
export function docOf(lib, now = Date.now()) {
  const order = lib.order.filter((id) => lib.entries.has(id));
  return {
    format: FORMAT,
    version: LIB_VERSION,
    updated: now,
    entries: order.map((id) => lib.entries.get(id)),
    meta: sortObj(new Map(order.map((id) => [id, metaOf(lib.entries.get(id), lib.meta.get(id))]))),
    tombs: sortObj(lib.tombs),
    labels: lib.labels || emptyLabels(),
    days: lib.days || {},
    seen: lib.seen || {},
    layoutTs: lib.layoutTs || 0,
  };
}
export const toDoc = (lib, now) => JSON.stringify(docOf(lib, now));

export function fromDoc(text) {
  let d;
  try { d = JSON.parse(text); } catch { throw new DavError('library.json on the server is not valid JSON — refusing to overwrite it', 0, 'format'); }
  return libFromDoc(d, 'library.json on the server');
}

/** Parsed library.json (or the library inside a backup) -> library. */
export function libFromDoc(d, what = 'library') {
  if (!d || d.format !== FORMAT || !Array.isArray(d.entries)) {
    throw new DavError(`${what} is not a Shiori library — refusing to overwrite it`, 0, 'format');
  }
  if (!(typeof d.version === 'number' && d.version <= LIB_VERSION)) {
    throw new DavError(`${what} was written by a newer Shiori (format ${d.version}). Update Shiori on this device; until then it does not sync, so it can't damage the newer data.`, 0, 'format');
  }
  const entries = new Map(), meta = new Map(), order = [];
  for (const e of d.entries) {
    if (!e || typeof e.id !== 'string') continue;
    if (!entries.has(e.id)) order.push(e.id);
    entries.set(e.id, normalizeEntry(e));
    if (d.meta && d.meta[e.id]) meta.set(e.id, d.meta[e.id]);
  }
  return {
    order, entries, meta,
    tombs: new Map(Object.entries(d.tombs || {}).filter(([, t]) => typeof t === 'number')),
    labels: { folder: d.labels && typeof d.labels.folder === 'object' && d.labels.folder ? d.labels.folder : {} },
    days: d.days && typeof d.days === 'object' && !Array.isArray(d.days) ? d.days : {},
    seen: d.seen && typeof d.seen === 'object' && !Array.isArray(d.seen) ? d.seen : {},
    layoutTs: typeof d.layoutTs === 'number' ? d.layoutTs : 0,
  };
}

// Every merge decision compares device timestamps, so a device whose clock is far off would
// win (or lose) every conflict, and a clock in the future could pin progress or delete series
// for as long as it is ahead. Refuse to write until the clock agrees with the server's.
export const MAX_CLOCK_SKEW_MS = 10 * 60e3;
function checkClock(remote, t) {
  const server = remote && remote.date ? Date.parse(remote.date) : NaN;
  if (!Number.isFinite(server) || Math.abs(t - server) <= MAX_CLOCK_SKEW_MS) return;
  const min = Math.round((t - server) / 60e3);
  throw new DavError(`This computer's clock is ${Math.abs(min)} min ${min > 0 ? 'ahead of' : 'behind'} the server's. Sync is paused until it is fixed (set the time automatically), because every merge decision compares times.`, 0, 'clock');
}

const sameContent = (a, b) => libraryFingerprint(a) === libraryFingerprint(b)
  && JSON.stringify(a.order) === JSON.stringify(b.order)
  && (a.layoutTs || 0) === (b.layoutTs || 0);

/**
 * One sync round. Never throws for "nothing to do"; throws DavError on failure.
 * @param {{store: import('./store.js').Store, dav: import('./webdav.js').WebDav, now?: ()=>number, log?: (s:string)=>void}} o
 * @returns {Promise<{pushed:boolean, pulled:number, attempts:number, conflicts:number, coversUp:number, coversDown:number}>}
 */
export async function syncOnce({ store, dav, now = Date.now, log = () => {}, dir = REMOTE_DIR }) {
  const { DIR, DOC, COVERS, BACKUPS } = pathsFor(dir);

  async function snapshot(text) {
    const st = await store.getSyncState();
    const iso = new Date(now()).toISOString();
    const day = iso.slice(0, 10);
    if (!st.snapNext && st.snapDay === day) return;
    const name = st.snapNext ? `library-${iso.slice(0, 16).replace(':', '-')}-before-import.json` : `library-${day}.json`;
    try {
      await dav.mkcol(BACKUPS);
      // another device may have taken today's snapshot already: that one is older, keep it
      if (st.snapNext || !(await dav.head(`${BACKUPS}/${name}`))) await dav.put(`${BACKUPS}/${name}`, text, { contentType: 'application/json' });
      const list = (await dav.propfind(BACKUPS + '/', 1)) || [];
      const old = list.filter((x) => !x.self && !x.dir && SNAP_RE.test(x.name)).map((x) => x.name).sort().slice(0, -KEEP_SNAPSHOTS);
      for (const n of old) await dav.delete(`${BACKUPS}/${n}`);
      await store.setSyncState({ snapDay: day, snapNext: false });
    } catch (err) {
      log(`snapshot failed, sync continues: ${err.message}`); // a missing snapshot must never block sync
    }
  }
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
    checkClock(remote, now());
    const remoteLib = remote ? fromDoc(remote.text) : null;

    // merge + persist locally under the store lock (tracker/UI edits wait for us)
    const plan = await store.withLock(async () => {
      const local = await store.loadLibrary();
      const m = remoteLib ? mergeLibraries(remoteLib, local) : local;
      if (!sameContent(m, local)) stats.pulled = await store.saveLibrary(m, { silent: true });
      return { m, needPush: !remoteLib || !sameContent(m, remoteLib) };
    });
    if (!plan.needPush) { merged = plan.m; await store.setSyncState({ etag: remote.etag || null }); break; }

    if (remote) await snapshot(remote.text);
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
  const needed = referencedImgKeys([...merged.entries.values()]);
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
