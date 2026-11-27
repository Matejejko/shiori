// Pure library operations: import planning (dry run + apply), backup export, local edits.

import { referencedImgKeys, verifyCover, withField, ID_RE } from './mangapin.js';
import { mergeLibraries, metaOf, tombTime, emptyLabels, seriesKey } from './merge.js';
import { docOf, libFromDoc } from './sync.js';
import { readMangaPin } from './mangapin-import.js';

export function emptyLibrary() {
  return { order: [], entries: new Map(), meta: new Map(), tombs: new Map(), labels: emptyLabels(), days: {}, seen: {}, folds: new Set(), layoutTs: 0 };
}

const BACKUP_FORMAT = 'shiori-backup';
const BACKUP_VERSION = 1;

/** Shiori backup: the library exactly as it syncs (incl. edit times and deletes) + its covers. */
export function exportBackup(lib, coverData, now = Date.now()) {
  const covers = {};
  for (const k of referencedImgKeys([...lib.entries.values()])) { const v = coverData(k); if (typeof v === 'string') covers[k] = v; }
  return JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exported: now, library: docOf(lib, now), covers });
}

/** Import file (Shiori backup, server snapshot or MangaPin export) -> { kind, lib, covers: Map<key,b64>, problems }. */
function readImportFile(text) {
  let d;
  try { d = JSON.parse(text); } catch (err) { throw new Error('not valid JSON: ' + err.message); }
  if (d && d.format === BACKUP_FORMAT) {
    if (!(typeof d.version === 'number' && d.version <= BACKUP_VERSION)) throw new Error(`this backup was made by a newer Shiori (format ${d.version}) — update Shiori first`);
    const covers = new Map(Object.entries(d.covers && typeof d.covers === 'object' ? d.covers : {}).filter(([, v]) => typeof v === 'string'));
    return { kind: 'shiori', lib: libFromDoc(d.library, 'the library in this backup'), covers, problems: [] };
  }
  // a library.json snapshot from the server's backups folder: its covers are on the server already
  if (d && d.format === 'shiori-library') return { kind: 'snapshot', lib: libFromDoc(d, 'this snapshot'), covers: new Map(), problems: [] };
  const mp = readMangaPin(text); // the one MangaPin -> Shiori conversion
  return { kind: 'mangapin', lib: { ...emptyLibrary(), order: mp.order, entries: mp.entries, meta: mp.meta }, covers: mp.covers, problems: mp.problems };
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
 * The file is a Shiori backup (its edit times and deletes merge in like another device's)
 * or a MangaPin export.
 *
 * @param {object} local             current library
 * @param {Set<string>} localCovers  cover keys present locally
 * @param {string} text              file contents
 * @param {'merge'|'replace'} mode
 * @param {'shiori'|'mangapin'} [source]  what the user chose to import (a Shiori backup or server snapshot, or a MangaPin export)
 */
export function planImport(local, localCovers, text, mode, now = Date.now(), source) {
  const read = readImportFile(text);
  // the user says what they are importing; a file of the other kind is refused, not guessed
  if (source && (source === 'mangapin') !== (read.kind === 'mangapin')) {
    throw new Error(read.kind === 'mangapin' ? 'this is a MangaPin export — choose "MangaPin export" above' : 'this is a Shiori file — choose "Shiori backup" above');
  }
  const { lib: file, covers: fileCovers } = read;
  const summary = {
    mode,
    kind: read.kind,
    fileEntries: file.entries.size,
    fileCovers: fileCovers.size,
    problems: read.problems.slice(0, 50),
    problemCount: read.problems.length,
    added: [], updated: [], unchanged: 0, removed: [], skippedDeleted: [], restored: [],
    missingCovers: [], unverifiedCovers: [], newCovers: 0,
  };

  // Cover keys should be local:<bytes>:<md5>.webp of the data. Covers that do not verify are
  // still kept verbatim (the key derivation is MangaPin's, not ours) but are not synced.
  for (const [k, v] of fileCovers) {
    if (!localCovers.has(k)) summary.newCovers++;
    if (!verifyCover(k, v)) summary.unverifiedCovers.push(k);
  }

  let lib;
  if (mode === 'replace') {
    // a series counts as "in the file" whatever id it has here (it is merged, not deleted)
    const fileSeries = new Set([...file.entries.values()].map(seriesKey));
    const keep = new Set([...file.entries.keys(), ...[...local.entries].filter(([, e]) => fileSeries.has(seriesKey(e))).map(([id]) => id)]);
    const tombs = new Map(local.tombs);
    for (const [id, e] of local.entries) {
      if (keep.has(id)) continue;
      tombs.set(id, tombTime(metaOf(e, local.meta.get(id)), now));
    }
    for (const id of file.entries.keys()) {
      if (local.tombs.has(id) && !local.entries.has(id)) summary.restored.push(short(file.entries.get(id)));
      tombs.delete(id);
      // keeping/restoring a series is a user decision as of now: it must outlive any
      // tombstone another device still has (rs/u only decide deletes, not field values)
      file.meta.set(id, { ...file.meta.get(id), rs: now });
    }
    const kept = { ...local, entries: new Map([...local.entries].filter(([id]) => keep.has(id))), tombs: new Map() };
    const merged = mergeLibraries(file, kept);
    for (const [id, t] of merged.tombs) tombs.set(id, Math.max(tombs.get(id) ?? -Infinity, t)); // incl. folded duplicates
    // the file's order, with each series under the id that survived de-duplication
    const survivor = new Map([...merged.entries].map(([id, e]) => [seriesKey(e), id]));
    const order = [...new Set([...file.order.map((id) => survivor.get(seriesKey(file.entries.get(id)))), ...merged.order])].filter((id) => merged.entries.has(id));
    lib = { ...merged, tombs, order, layoutTs: now };
  } else {
    // deleted here and not live under another id (a folded duplicate is merged, not skipped)
    const liveSeries = new Set([...local.entries.values()].map(seriesKey));
    const skip = new Set([...file.entries].filter(([id, e]) => local.tombs.has(id) && !local.entries.has(id) && !liveSeries.has(seriesKey(e))).map(([id]) => id));
    for (const id of skip) { summary.skippedDeleted.push(short(file.entries.get(id))); file.entries.delete(id); file.meta.delete(id); }
    file.order = file.order.filter((id) => !skip.has(id));
    const merged = mergeLibraries({ ...local, layoutTs: now }, { ...file, layoutTs: 0 });
    lib = { ...merged, layoutTs: now };
  }
  // classify by series, so the same series under another id counts as updated, not added
  const localBySeries = new Map([...local.entries.values()].map((e) => [seriesKey(e), e]));
  const libBySeries = new Map([...lib.entries.values()].map((e) => [seriesKey(e), e]));
  const restoredIds = new Set(summary.restored.map((x) => x.id));
  for (const [id, e] of file.entries) {
    if (restoredIds.has(id)) continue;
    const le = local.entries.get(id) || localBySeries.get(seriesKey(e));
    const me = libBySeries.get(seriesKey(e));
    if (!le) summary.added.push(short(e));
    else if (JSON.stringify(le) !== JSON.stringify(me)) summary.updated.push(short(e));
    else summary.unchanged++;
  }

  // every series this import deletes here — replace's "not in the file", and in either mode the
  // deletes a backup carries from its device — so the dry run never hides one
  for (const [id, e] of local.entries) if (!lib.entries.has(id) && !libBySeries.has(seriesKey(e))) summary.removed.push(short(e));

  // covers referenced but present neither in the file nor locally (tolerated, preserved);
  // a snapshot's covers come from the server with the next sync
  for (const e of read.kind === 'snapshot' ? [] : lib.entries.values()) {
    if (typeof e.img === 'string' && e.img.startsWith('local:') && !fileCovers.has(e.img) && !localCovers.has(e.img)) {
      summary.missingCovers.push({ ...short(e), img: e.img });
    }
  }
  summary.planId = planId(mode, summary);

  const covers = new Map([...fileCovers].filter(([k]) => !localCovers.has(k)));
  return { summary, lib, covers };
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
  const edited = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'progress' || k === 'latest' || k === 'next' || k === 'ts' || k === 'id' || k === 'createTs') continue;
    edited.push(k);
    if (v === undefined) { if (Object.prototype.hasOwnProperty.call(out, k)) { out = { ...out }; delete out[k]; } }
    else out = withField(out, k, v);
  }
  const ts = now > (e.ts || 0) ? now : (e.ts || 0) + 1;
  out = withField(out, 'ts', ts);
  lib.entries.set(id, out);
  const m = metaOf(e, lib.meta.get(id));
  // only the edited fields get the new time; the rest keep the base time r
  const f = { ...(m.f || {}) };
  for (const k of edited) f[k] = ts;
  lib.meta.set(id, metaOf(out, { ...m, f }));
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
      const was = [...initial.tags].sort(), now = [...new Set(current.tags)].sort();
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
  const meta = { ...m };
  delete meta.pf; delete meta.pm;
  if (manual) meta.pm = ts;
  else if (m.pm !== undefined) meta.pm = m.pm;
  lib.meta.set(id, meta);
  return true;
}

export function deleteEntry(lib, id, now = Date.now()) {
  const e = lib.entries.get(id);
  if (!e) return false;
  lib.tombs.set(id, tombTime(metaOf(e, lib.meta.get(id)), now));
  lib.entries.delete(id);
  lib.meta.delete(id);
  lib.order = lib.order.filter((x) => x !== id);
  return true;
}

/** Add a new entry (already in MangaPin shape). Returns it. */
/**
 * Move a series to another site (the old one died or changed domain): a new entry with the new
 * site + slug carries over everything that is yours — progress (as a chapter number), folder,
 * tags, score, dates, cover, name — and the old id is deleted. The old site's chapter data
 * (latest/next, site ids) dies with the old id, so no device can sync it back onto the new site.
 * Returns the new id.
 */
export function moveEntry(lib, id, { siteId, slug, url }, now = Date.now()) {
  const e = lib.entries.get(id);
  if (!e) throw new Error('no such entry');
  if (!siteId || !slug) throw new Error('That is not a series page.');
  const target = seriesKey({ siteId, slug });
  if (target === seriesKey(e)) throw new Error('The series is already on that site.');
  for (const o of lib.entries.values()) if (seriesKey(o) === target) throw new Error(`“${o.name}” is already in your library under that site.`);
  const newIdv = newId(new Set([...lib.entries.keys(), ...lib.tombs.keys()]));
  const drop = new Set(['latest', 'next', 'rawId', 'titleId', 'url']);
  let out = {};
  for (const k of Object.keys(e)) if (!drop.has(k)) Object.defineProperty(out, k, { value: e[k], enumerable: true, writable: true, configurable: true });
  out = withField(withField(withField(out, 'siteId', siteId), 'slug', slug), 'id', newIdv);
  if (url) out = withField(out, 'url', url);
  // chapter numbers carry over; the old site's chapter slug does not
  if (typeof e.progress?.chap === 'number') out = withField(out, 'progress', { chap: e.progress.chap, ts: now });
  out = withField(out, 'ts', Math.max(now, (e.ts || 0) + 1));
  const at = lib.order.indexOf(id);
  lib.entries.set(newIdv, out);
  lib.meta.set(newIdv, metaOf(out, { r: out.ts }));
  lib.order.splice(at < 0 ? lib.order.length : at, 0, newIdv);
  deleteEntry(lib, id, now);
  return newIdv;
}

/** Local calendar day of a time, 'YYYY-MM-DD' (the reading log's key). */
export function dayKey(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** One chapter read on this device today (see mergeDays). */
export function countRead(lib, device, now = Date.now()) {
  const days = lib.days || (lib.days = {});
  const mine = days[device] || (days[device] = {});
  const k = dayKey(now);
  mine[k] = (mine[k] || 0) + 1;
}

export function addEntry(lib, entry, now = Date.now()) {
  lib.entries.set(entry.id, entry);
  lib.meta.set(entry.id, metaOf(entry, { r: entry.ts ?? now }));
  lib.order.push(entry.id); // appended, like sync does for entries the server has not seen
  return entry;
}

export function findBySeries(lib, siteId, slug) {
  const k = seriesKey({ siteId, slug });
  for (const e of lib.entries.values()) if (seriesKey(e) === k) return e;
  return null;
}

/** New chapters past your progress. Series you have not started are not "unread". */
export function isUnread(e) {
  const l = e.latest && typeof e.latest.chap === 'number' ? e.latest.chap : null;
  const p = e.progress && typeof e.progress.chap === 'number' ? e.progress.chap : null;
  return l !== null && p !== null && l > p;
}
