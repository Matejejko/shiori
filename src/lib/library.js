// Pure library operations: import planning (dry run + apply), export, local edits.

import { parseExport, serializeExport, referencedImgKeys, verifyCover, withField, ID_RE } from './mangapin.js';
import { mergeLibraries, mergeEntry, editTs, metaOf, emptyLabels } from './merge.js';

export function emptyLibrary() {
  return { order: [], entries: new Map(), meta: new Map(), tombs: new Map(), labels: emptyLabels(), top: null, keepImgs: [], layoutTs: 0 };
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

/** Short stable fingerprint of what an import will do (dry run vs apply must agree). */
function planId(mode, summary) {
  const ids = (l) => l.map((x) => x.id).sort().join(',');
  const s = `${mode}|a:${ids(summary.added)}|u:${ids(summary.updated)}|r:${ids(summary.removed)}|s:${ids(summary.skippedDeleted)}|x:${ids(summary.restored)}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(36) + '-' + s.length.toString(36);
}

/**
 * Plan an import (dry run). Nothing is written; the caller persists `lib` + `covers`.
 *
 * merge:   file entries merge into the library entry by entry (newer edits / furthest reading
 *          win, exactly like sync). Series you deleted here are NOT re-added.
 * replace: the file decides which series exist: series not in the file are deleted (on every
 *          device), deleted series that are in the file come back, and the file's order/layout
 *          becomes the library's. Per entry it still merges like sync, so it never rolls back
 *          reading or newer edits on another device. The background syncs first so that the
 *          plan sees series that so far only exist on other devices.
 * Both make this device's layout (order, top-level keys, orphan covers) authoritative.
 *
 * @param {object} local             current library
 * @param {Set<string>} localCovers  cover keys present locally
 * @param {string} text              file contents
 * @param {'merge'|'replace'} mode
 */
export function planImport(local, localCovers, text, mode, now = Date.now()) {
  const parsed = parseExport(text);
  const summary = {
    mode,
    fileEntries: parsed.entries.length,
    fileCovers: parsed.imgs.size,
    exact: false,
    problems: parsed.problems.slice(0, 50),
    problemCount: parsed.problems.length,
    added: [], updated: [], unchanged: 0, removed: [], skippedDeleted: [], restored: [],
    missingCovers: [], unverifiedCovers: [], newCovers: 0, duplicateSeries: [],
  };

  // Cover keys should be local:<bytes>:<md5>.webp of the data. Covers that do not verify are
  // still kept verbatim (the key derivation is MangaPin's, not ours) but are not synced.
  for (const [k, v] of parsed.imgs) {
    if (!localCovers.has(k)) summary.newCovers++;
    if (!verifyCover(k, v)) summary.unverifiedCovers.push(k);
  }

  // A file entry's rest fields carry MangaPin's ts; its progress is a plain read event.
  const file = libFromParsed(parsed, (obj) => ({ r: typeof obj.ts === 'number' ? obj.ts : 0 }));
  let lib;
  if (mode === 'replace') {
    const keep = new Set(file.entries.keys());
    const tombs = new Map(local.tombs);
    for (const [id, e] of local.entries) {
      if (keep.has(id)) continue;
      tombs.set(id, Math.max(now, editTs(e, local.meta.get(id)) + 1));
      summary.removed.push(short(e));
    }
    for (const id of keep) {
      if (local.tombs.has(id) && !local.entries.has(id)) summary.restored.push(short(file.entries.get(id)));
      tombs.delete(id);
      // keeping/restoring a series is a user decision as of now: it must outlive any
      // tombstone another device still has (u only decides deletes, not field values)
      file.meta.set(id, { ...file.meta.get(id), u: now });
    }
    const kept = { ...local, entries: new Map([...local.entries].filter(([id]) => keep.has(id))), tombs: new Map() };
    const merged = mergeLibraries(file, kept);
    lib = { ...merged, tombs, labels: local.labels || emptyLabels(), top: parsed.top, keepImgs: file.keepImgs, order: file.order.filter((id) => merged.entries.has(id)), layoutTs: now };
  } else {
    const skip = new Set([...file.entries.keys()].filter((id) => local.tombs.has(id) && !local.entries.has(id)));
    for (const id of skip) { summary.skippedDeleted.push(short(file.entries.get(id))); file.entries.delete(id); file.meta.delete(id); }
    file.order = file.order.filter((id) => !skip.has(id));
    const merged = mergeLibraries({ ...local, layoutTs: now }, { ...file, layoutTs: 0 });
    lib = { ...merged, top: local.top || parsed.top, keepImgs: [...new Set([...(local.keepImgs || []), ...file.keepImgs])], layoutTs: now };
  }
  for (const [id, e] of file.entries) {
    const le = local.entries.get(id);
    const me = lib.entries.get(id);
    if (!le) { if (!summary.restored.some((x) => x.id === id)) summary.added.push(short(e)); }
    else if (JSON.stringify(le) !== JSON.stringify(me)) summary.updated.push(short(e));
    else summary.unchanged++;
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

  // "re-export is byte-identical" only when the file is plain JSON.stringify output, every entry
  // survived parsing (string ids, no duplicates) and, for replace, nothing else gets merged in
  summary.exact = parsed.canonical && !parsed.duplicateIds && !parsed.droppedEntries
    && (mode === 'replace' ? summary.updated.length === 0 : local.entries.size === 0);
  summary.planId = planId(mode, summary);

  const covers = new Map([...parsed.imgs].filter(([k]) => !localCovers.has(k)));
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
    if (v === undefined) { if (Object.prototype.hasOwnProperty.call(out, k)) { out = { ...out }; delete out[k]; } }
    else out = withField(out, k, v);
  }
  const ts = now > (e.ts || 0) ? now : (e.ts || 0) + 1;
  out = withField(out, 'ts', ts);
  lib.entries.set(id, out);
  const m = metaOf(e, lib.meta.get(id));
  lib.meta.set(id, { ...m, r: ts, u: Math.max(m.u, ts) });
  return out;
}

/**
 * Editor form -> patch with only the fields the user actually changed. `initial` and
 * `current` are the form values when the dialog opened and on Save, so an untouched Save is
 * a no-op and a field edited elsewhere meanwhile is not overwritten with a stale value.
 * Tags keep the entry's own order for kept tags (MangaPin stores them unsorted).
 */
export function formPatch(entry, initial, current) {
  const patch = {};
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const k of Object.keys(current)) {
    if (k === 'tags') {
      const was = [...initial.tags].sort((a, b) => a - b), now = [...new Set(current.tags)].sort((a, b) => a - b);
      if (same(was, now)) continue;
      const keep = new Set(now);
      const own = (Array.isArray(entry.tags) ? entry.tags : []).filter((t) => keep.has(t));
      patch.tags = [...own, ...now.filter((t) => !own.includes(t))];
    } else if (!same(initial[k], current[k])) {
      patch[k] = current[k];
    }
  }
  return patch;
}

/**
 * Set progress. `manual` = a deliberate correction (may go backwards; becomes the new
 * reference point, see merge.js); otherwise forward-only (auto-tracking).
 * Returns true if the entry changed.
 */
export function setProgress(lib, id, chap, { manual = false, slug, now = Date.now() } = {}) {
  const e = lib.entries.get(id);
  if (!e || typeof chap !== 'number' || !Number.isFinite(chap) || chap < 0) return false;
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
  // the new read is newer than every earlier event and (auto) further than all of them,
  // so it dominates the whole frontier
  const meta = { r: m.r, u: Math.max(m.u, ts) };
  if (manual) meta.pm = ts;
  else if (m.pm !== undefined) meta.pm = m.pm;
  lib.meta.set(id, meta);
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
  lib.meta.set(entry.id, metaOf(entry, { r: entry.ts ?? now }));
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
