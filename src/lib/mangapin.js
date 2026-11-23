// MangaPin export format: {"version":1,"entries":[…],"imgs":{"local:<bytes>:<md5>.webp":"<base64>"}}
// written by plain JSON.stringify. Entries are kept as raw JSON strings end-to-end so key
// order (and unknown fields) survive untouched. chrome.storage.local sorts object keys,
// which is why nothing here ever stores an entry as an object.

import { md5 } from './md5.js';
import { b64ToBytes } from './base64.js';

/** MangaPin's field order as observed in real exports; used only when inserting a field
 *  that an entry did not have before (existing entries keep their own order). */
export const ENTRY_FIELD_ORDER = [
  'siteId', 'slug', 'url', 'name', 'img', 'next', 'latest', 'progress', 'cLang', 'folder',
  'type', 'tags', 'score', 'startTs', 'endTs', 'ts', 'createTs', 'id', 'rawId', 'titleId',
];

export const ID_RE = /^[A-Za-z0-9]{10}$/;
const COVER_KEY_RE = /^local:(\d+):([0-9a-f]{32})\.webp$/;
const COVER_FILE_RE = /^(\d+)-([0-9a-f]{32})\.webp$/;

export function parseCoverKey(key) {
  const m = typeof key === 'string' && COVER_KEY_RE.exec(key);
  return m ? { bytes: Number(m[1]), md5: m[2] } : null;
}
export function coverKeyFor(bytes) {
  return `local:${bytes.length}:${md5(bytes)}.webp`;
}
export function coverKeyToFile(key) {
  const p = parseCoverKey(key);
  return p ? `${p.bytes}-${p.md5}.webp` : null;
}
export function coverFileToKey(name) {
  const m = COVER_FILE_RE.exec(name);
  return m ? `local:${m[1]}:${m[2]}.webp` : null;
}
/** true if base64 payload decodes to bytes whose length+md5 match the key */
export function verifyCover(key, b64) {
  const p = parseCoverKey(key);
  if (!p) return false;
  const bytes = b64ToBytes(b64);
  return bytes.length === p.bytes && md5(bytes) === p.md5;
}

const pad = (n) => String(n).padStart(2, '0');
export function exportFileName(d = new Date()) {
  return `MangaPin${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}

/** Insert `key: value` into obj respecting ENTRY_FIELD_ORDER if the key is new;
 *  replace in place otherwise. Returns a new object (key order deterministic). */
export function withField(obj, key, value) {
  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = k === key ? value : obj[k];
    return out;
  }
  const rank = ENTRY_FIELD_ORDER.indexOf(key);
  const out = {};
  let placed = false;
  for (const k of Object.keys(obj)) {
    const r = ENTRY_FIELD_ORDER.indexOf(k);
    if (!placed && rank !== -1 && r !== -1 && r > rank) { out[key] = value; placed = true; }
    out[k] = obj[k];
  }
  if (!placed) out[key] = value;
  return out;
}

function maxNestedTs(e) {
  let m = -Infinity;
  for (const k of ['next', 'latest', 'progress']) {
    const t = e[k] && typeof e[k] === 'object' ? e[k].ts : undefined;
    if (typeof t === 'number' && t > m) m = t;
  }
  return m;
}

/** Light validation; returns list of problems (strings). Never mutates. */
export function validateEntry(e) {
  const p = [];
  if (!e || typeof e !== 'object' || Array.isArray(e)) return ['entry is not an object'];
  if (typeof e.id !== 'string' || !ID_RE.test(e.id)) p.push(`bad id ${JSON.stringify(e.id)}`);
  if (typeof e.siteId !== 'string' || !e.siteId) p.push('missing siteId');
  if (typeof e.slug !== 'string') p.push('missing slug');
  if (typeof e.name !== 'string') p.push('missing name');
  if (typeof e.ts !== 'number') p.push('missing ts');
  else if (maxNestedTs(e) > e.ts) p.push('ts older than nested ts');
  if (e.tags !== undefined && !Array.isArray(e.tags)) p.push('tags not an array');
  return p;
}

/**
 * Parse a MangaPin export. Returns
 * { version, entries: [{id, raw, obj}], imgs: Map<key,b64>, top: {order:[keys], raw:{key:rawJSON}},
 *   problems: [...], canonical: bool }
 * `canonical` = the file is exactly what JSON.stringify produces (so a re-export is byte-identical).
 */
export function parseExport(text) {
  let data;
  try { data = JSON.parse(text); } catch (err) { throw new Error('not valid JSON: ' + err.message); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a MangaPin export (top level is not an object)');
  if (!Array.isArray(data.entries)) throw new Error('not a MangaPin export (no "entries" array)');
  if (data.imgs !== undefined && (typeof data.imgs !== 'object' || data.imgs === null || Array.isArray(data.imgs))) {
    throw new Error('not a MangaPin export ("imgs" is not an object)');
  }
  const problems = [];
  if (data.version !== 1) problems.push(`unexpected version ${JSON.stringify(data.version)} (expected 1)`);

  const top = { order: Object.keys(data), raw: {} };
  for (const k of top.order) if (k !== 'entries' && k !== 'imgs') top.raw[k] = JSON.stringify(data[k]);

  const entries = [];
  const seen = new Set();
  data.entries.forEach((obj, i) => {
    const errs = validateEntry(obj);
    for (const e of errs) problems.push(`entry #${i}${obj && obj.name ? ` (${String(obj.name).slice(0, 40)})` : ''}: ${e}`);
    if (!obj || typeof obj !== 'object' || typeof obj.id !== 'string') return; // unusable without an id
    if (seen.has(obj.id)) problems.push(`entry #${i}: duplicate id ${obj.id} (will be merged)`);
    seen.add(obj.id);
    entries.push({ id: obj.id, raw: JSON.stringify(obj), obj });
  });

  const imgs = new Map();
  for (const [k, v] of Object.entries(data.imgs || {})) {
    if (typeof v !== 'string') { problems.push(`imgs[${k}] is not a string`); continue; }
    if (!parseCoverKey(k)) problems.push(`imgs key ${k} is not local:<bytes>:<md5>.webp`);
    imgs.set(k, v);
  }
  return { version: data.version, entries, imgs, top, problems, canonical: JSON.stringify(data) === text };
}

/** Image keys referenced by entries, in first-reference order. */
export function referencedImgKeys(entryObjs) {
  const out = [];
  const seen = new Set();
  for (const e of entryObjs) {
    const k = e && e.img;
    if (typeof k === 'string' && k.startsWith('local:') && !seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}

/**
 * Serialize an export exactly like MangaPin's JSON.stringify would.
 * @param {object} p
 * @param {string[]} p.entriesRaw  raw JSON strings of entries, in export order
 * @param {string[]} p.imgKeys     image keys in output order
 * @param {(key:string)=>string|undefined} p.imgData  base64 lookup (missing keys are skipped)
 * @param {{order:string[], raw:Object<string,string>}} [p.top] top-level layout from the last import
 */
export function serializeExport({ entriesRaw, imgKeys, imgData, top }) {
  const order = top && top.order && top.order.length ? top.order : ['version', 'entries', 'imgs'];
  const raw = (top && top.raw) || {};
  const parts = [];
  const emitted = new Set();
  const emit = (k) => {
    if (emitted.has(k)) return;
    emitted.add(k);
    if (k === 'entries') parts.push('"entries":[' + entriesRaw.join(',') + ']');
    else if (k === 'imgs') {
      const kv = [];
      for (const key of imgKeys) {
        const v = imgData(key);
        if (typeof v === 'string') kv.push(JSON.stringify(key) + ':' + JSON.stringify(v));
      }
      parts.push('"imgs":{' + kv.join(',') + '}');
    } else if (k === 'version') parts.push('"version":' + (raw.version ?? '1'));
    else if (raw[k] !== undefined) parts.push(JSON.stringify(k) + ':' + raw[k]);
  };
  for (const k of order) emit(k);
  // Keys the original file lacked are only added when needed, so a file without them
  // still round-trips byte-identically.
  if (!top) emit('version');
  emit('entries');
  if (!emitted.has('imgs') && imgKeys.some((k) => typeof imgData(k) === 'string')) emit('imgs');
  return '{' + parts.join(',') + '}';
}
