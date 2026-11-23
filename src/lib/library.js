// Pure library operations: import planning (dry run + apply), export, local edits.

import { parseExport, serializeExport, referencedImgKeys, verifyCover, parseCoverKey, withField, ID_RE } from './mangapin.js';
import { mergeLibraries, mergeEntry, editTs, metaOf, emptyLabels, canonical } from './merge.js';

export function emptyLibrary() {
  return { order: [], entries: new Map(), meta: new Map(), tombs: new Map(), labels: emptyLabels(), top: null, keepImgs: [] };
}

function cloneLib(lib) {
  return {
    order: [...lib.order], entries: new Map(lib.entries), meta: new Map(lib.meta), tombs: new Map(lib.tombs),
    labels: lib.labels || emptyLabels(), top: lib.top || null, keepImgs: [...(lib.keepImgs || [])],
  };
}

/** Library built from a parsed export (duplicate ids inside the file are merged). */
function libFromParsed(parsed, metaFor) {
  const lib = emptyLibrary();
  for (const { id, obj } of parsed.entries) {
    const prev = lib.entries.get(id);
    const m = metaFor(obj);
    if (prev) {
      const r = mergeEntry(prev, lib.meta.get(id), obj, m);
      lib.entries.set(id, r.entry); lib.meta.set(id, r.meta);
    } else {
      lib.entries.set(id, obj); lib.meta.set(id, m); lib.order.push(id);
    }
  }
  lib.top = parsed.top;
  const referenced = new Set(referencedImgKeys([...lib.entries.values()]));
  lib.keepImgs = [...parsed.imgs.keys()].filter((k) => !referenced.has(k));
  return lib;
}

const short = (e) => ({ id: e.id, name: typeof e.name === 'string' ? e.name : '', siteId: e.siteId });

/**
 * Dry-run an import. Nothing is written; call applyImport() with the returned plan.
 * @param {object} local         current library
 * @param {Set<string>} localCovers  cover keys present locally
 * @param {string} text          file contents
 * @param {'merge'|'replace'} mode
 */
export function planImport(local, localCovers, text, mode, now = Date.now()) {
  const parsed = parseExport(text);
  const summary = {
    mode,
    fileEntries: parsed.entries.length,
    fileCovers: parsed.imgs.size,
    canonical: parsed.canonical,
    problems: parsed.problems.slice(0, 50),
    problemCount: parsed.problems.length,
    added: [], updated: [], unchanged: 0, removed: [], skippedDeleted: [], restored: [],
    missingCovers: [], badCovers: [], newCovers: 0, duplicateSeries: [],
  };

  // cover integrity: key must be local:<decoded byte length>:<md5 of decoded bytes>.webp
  for (const [k, v] of parsed.imgs) {
    if (!parseCoverKey(k) || !verifyCover(k, v)) summary.badCovers.push(k);
    else if (!localCovers.has(k)) summary.newCovers++;
  }

  let lib;
  if (mode === 'replace') {
    // "Replace" means: the file is the truth as of now. Its entries get rest/progress
    // times of `now` in the sidecar so they win the next sync against the server, and every
    // local entry missing from the file gets a tombstone so the removal propagates too.
    const file = libFromParsed(parsed, () => ({ r: now, pe: now, u: now }));
    lib = cloneLib(file);
    lib.labels = local.labels || emptyLabels();
    lib.tombs = new Map(local.tombs);
    for (const [id, e] of local.entries) {
      if (!file.entries.has(id)) {
        lib.tombs.set(id, Math.max(now, editTs(e, local.meta.get(id)) + 1));
        summary.removed.push(short(e));
      }
    }
    for (const [id, e] of file.entries) {
      if (local.tombs.has(id) && !local.entries.has(id)) summary.restored.push(short(e));
      lib.tombs.delete(id); // remote tombstones are older than `now`, so the entry survives sync
      const le = local.entries.get(id);
      if (!le) summary.added.push(short(e));
      else if (JSON.stringify(le) !== JSON.stringify(e)) summary.updated.push(short(e));
      else summary.unchanged++;
    }
  } else {
    // A file entry's progress joins the local progress epoch if it was recorded after the
    // last local manual correction (it continued from it); otherwise it is older (epoch 0).
    const file = libFromParsed(parsed, (obj) => {
      const lm = local.entries.has(obj.id) ? metaOf(local.entries.get(obj.id), local.meta.get(obj.id)) : null;
      const pts = obj.progress && typeof obj.progress.ts === 'number' ? obj.progress.ts : -Infinity;
      return { r: typeof obj.ts === 'number' ? obj.ts : 0, pe: lm && pts >= lm.pe ? lm.pe : 0 };
    });
    const merged = mergeLibraries(local, file);
    lib = { ...merged, top: local.top || parsed.top, keepImgs: [...new Set([...(local.keepImgs || []), ...file.keepImgs])] };
    for (const [id, e] of file.entries) {
      const le = local.entries.get(id);
      const me = merged.entries.get(id);
      if (!me) { summary.skippedDeleted.push(short(e)); continue; }
      if (!le) summary.added.push(short(e));
      else if (JSON.stringify(le) !== JSON.stringify(me) || canonical(metaOf(le, local.meta.get(id))) !== canonical(merged.meta.get(id))) summary.updated.push(short(e));
      else summary.unchanged++;
    }
  }

  // covers referenced but present neither in the file nor locally (tolerated, preserved)
  for (const e of lib.entries.values()) {
    if (typeof e.img === 'string' && e.img.startsWith('local:') && !parsed.imgs.has(e.img) && !localCovers.has(e.img)) {
      summary.missingCovers.push({ ...short(e), img: e.img });
    }
  }
  // same series under different ids
  const bySeries = new Map();
  for (const e of lib.entries.values()) {
    const k = e.siteId + '\u0000' + e.slug;
    if (!bySeries.has(k)) bySeries.set(k, []);
    bySeries.get(k).push(e);
  }
  for (const list of bySeries.values()) if (list.length > 1) summary.duplicateSeries.push(list.map(short));

  const covers = new Map([...parsed.imgs].filter(([k]) => !localCovers.has(k) && !summary.badCovers.includes(k)));
  return { summary, lib, covers };
}

/** Build the MangaPin export string. `coverData(key)` returns base64 or undefined. */
export function exportString(lib, coverData) {
  const entries = lib.order.filter((id) => lib.entries.has(id)).map((id) => lib.entries.get(id));
  const imgKeys = referencedImgKeys(entries);
  const seen = new Set(imgKeys);
  for (const k of lib.keepImgs || []) if (!seen.has(k)) { seen.add(k); imgKeys.push(k); }
  return serializeExport({ entriesRaw: entries.map((e) => JSON.stringify(e)), imgKeys, imgData: coverData, top: lib.top });
}

/** Cover keys an export / sync needs. */
export function neededCoverKeys(lib) {
  const keys = referencedImgKeys([...lib.entries.values()]);
  for (const k of lib.keepImgs || []) if (!keys.includes(k)) keys.push(k);
  return keys;
}

// ---- local edits ----------------------------------------------------------------------

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function newId(existing = new Set()) {
  for (;;) {
    let id = '';
    while (id.length < 10) {
      const buf = new Uint8Array(16);
      crypto.getRandomValues(buf);
      for (const b of buf) if (b < 248 && id.length < 10) id += ALNUM[b % 62]; // 248 = 4*62: unbiased
    }
    if (ID_RE.test(id) && !existing.has(id)) return id;
  }
}

/** Apply user edits to "rest" fields. `patch` values of undefined delete the field. */
export function editEntry(lib, id, patch, now = Date.now()) {
  const e = lib.entries.get(id);
  if (!e) throw new Error('no such entry');
  let out = e;
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'progress' || k === 'latest' || k === 'next' || k === 'ts' || k === 'id' || k === 'createTs') continue;
    if (v === undefined) { if (k in out) { out = { ...out }; delete out[k]; } }
    else out = withField(out, k, v);
  }
  const ts = Math.max(now, e.ts || 0);
  out = withField(out, 'ts', ts);
  lib.entries.set(id, out);
  const m = metaOf(e, lib.meta.get(id));
  lib.meta.set(id, { r: ts, pe: m.pe, u: Math.max(m.u, ts) });
  return out;
}

/**
 * Set progress. `manual` = a deliberate correction (may go backwards, starts a new epoch);
 * otherwise forward-only (auto-tracking). Returns true if the entry changed.
 */
export function setProgress(lib, id, chap, { manual = false, slug, now = Date.now() } = {}) {
  const e = lib.entries.get(id);
  if (!e || typeof chap !== 'number' || !Number.isFinite(chap)) return false;
  const cur = e.progress;
  if (!manual && cur && typeof cur.chap === 'number' && chap <= cur.chap) return false;
  if (manual && cur && cur.chap === chap) return false;
  const ts = now > (e.ts || 0) ? now : (e.ts || 0) + 1; // strictly newer than the entry
  const progress = { chap };
  if (slug !== undefined && slug !== null && slug !== '') progress.slug = String(slug);
  progress.ts = ts;
  let out = withField(e, 'progress', progress);
  out = withField(out, 'ts', ts);
  lib.entries.set(id, out);
  const m = metaOf(e, lib.meta.get(id));
  lib.meta.set(id, { r: m.r, pe: manual ? ts : m.pe, u: Math.max(m.u, ts) });
  return true;
}

export function deleteEntry(lib, id, now = Date.now()) {
  const e = lib.entries.get(id);
  if (!e) return false;
  lib.tombs.set(id, Math.max(now, editTs(e, lib.meta.get(id)) + 1));
  lib.entries.delete(id);
  lib.meta.delete(id);
  lib.order = lib.order.filter((x) => x !== id);
  return true;
}

/** Add a new entry (already in MangaPin shape). Returns it. */
export function addEntry(lib, entry, now = Date.now()) {
  lib.entries.set(entry.id, entry);
  lib.meta.set(entry.id, metaOf(entry, { r: entry.ts ?? now, pe: 0 }));
  lib.order.push(entry.id); // appended, like sync does for entries the server has not seen
  return entry;
}

export function findBySeries(lib, siteId, slug) {
  for (const e of lib.entries.values()) if (e.siteId === siteId && e.slug === slug) return e;
  return null;
}

/** New chapters past your progress. Series you have not started are not "unread". */
export function isUnread(e) {
  const l = e.latest && typeof e.latest.chap === 'number' ? e.latest.chap : null;
  const p = e.progress && typeof e.progress.chap === 'number' ? e.progress.chap : null;
  return l !== null && p !== null && l > p;
}
