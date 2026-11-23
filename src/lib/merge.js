// Deterministic merge of MangaPin entries and Shiori libraries.
//
// Field groups of an entry:
//   progress — "furthest chapter read since your last manual correction".
//              Every progress value ever recorded is a read event (chap, ts). With
//              pm = time of the latest manual correction, the result is the event with the
//              highest chapter among events with ts >= pm. So:
//                - a stale device that reads an old chapter offline cannot pull progress back
//                  (no correction -> highest chapter wins),
//                - a manual correction (popup/editor "Set") wins even when it goes backwards,
//                - and reads made *after* a correction on a device that had not seen it yet
//                  still count.
//              To stay associative the merge keeps the Pareto frontier of events (no other
//              event has both a higher chapter and a later ts) in the sidecar (`pf`); with
//              forward-only tracking it is almost always empty.
//   latest   — max by (chap, ts)
//   next     — max by (ts)
//   rest     — every other field, taken whole from the side with the newer "rest time"
//              (sidecar `r`, the last time a user edited those fields; defaults to entry.ts).
//              Release checks and tracking bump entry.ts but not `r`, so they can't clobber
//              a tag/folder edit made on another machine.
//   ts       — max
// Every choice is a join in a semilattice (max over a total order, or set union + frontier),
// which makes the merge commutative, associative and idempotent (property-tested).
//
// Entries are never reshaped: the winner's object is copied with its own key order and only
// the three group fields (+ts) are replaced in place (or inserted in MangaPin's field order).
//
// Sidecar meta per id: { r, pm?, u, pf? } — rest time, manual-correction time, last user
// edit/read time (decides tombstones; max-merged), extra frontier events. It lives in
// Shiori's storage and library.json only — never in a MangaPin export.

import { withField } from './mangapin.js';

const GROUP = new Set(['progress', 'latest', 'next', 'ts']);
const NEG = -Infinity;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NEG);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** JSON with recursively sorted keys — a representation independent of key order. */
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v) ?? 'null';
}

function restOf(e) {
  const o = {};
  for (const k of Object.keys(e)) if (!GROUP.has(k)) Object.defineProperty(o, k, { value: e[k], enumerable: true, writable: true, configurable: true });
  return o;
}

export function metaOf(entry, meta) {
  const r = typeof meta?.r === 'number' ? meta.r : num(entry?.ts) === NEG ? 0 : entry.ts;
  // pm: manual-correction time (older builds called it `pe`, with 0 meaning "none")
  const pm = typeof meta?.pm === 'number' ? meta.pm : typeof meta?.pe === 'number' && meta.pe > 0 ? meta.pe : NEG;
  const u = Math.max(typeof meta?.u === 'number' ? meta.u : NEG, r, num(entry?.progress?.ts));
  const pf = Array.isArray(meta?.pf) ? meta.pf.filter((x) => isObj(x)) : [];
  const out = { r, u };
  if (pm !== NEG) out.pm = pm;
  if (pf.length) out.pf = pf;
  return out;
}

/** Time of the last user-intended change; tombstones only beat entries older than this. */
export function editTs(entry, meta) {
  return metaOf(entry, meta).u;
}

function compareRest(a, ma, b, mb) {
  return cmp(ma.r, mb.r)
    || cmp(canonical(restOf(a)), canonical(restOf(b)))
    || cmp(JSON.stringify(restOf(a)), JSON.stringify(restOf(b)))
    || cmp(JSON.stringify(a), JSON.stringify(b));
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

// Comparators for group fields; `undefined` loses to anything present.
function cmpEvent(x, y) {
  return cmp(num(x.chap), num(y.chap)) || cmp(num(x.ts), num(y.ts))
    || cmp(canonical(x), canonical(y)) || cmp(JSON.stringify(x), JSON.stringify(y));
}

/** Progress join: returns {progress, pm, pf} (see header). */
export function mergeProgress(pa, ma, pb, mb) {
  const pm = Math.max(ma.pm ?? NEG, mb.pm ?? NEG);
  const events = [];
  for (const p of [pa, ...(ma.pf || []), pb, ...(mb.pf || [])]) if (isObj(p) && num(p.chap) !== NEG) events.push(p);
  if (!events.length) return { progress: undefined, pm, pf: [] };
  let eligible = events.filter((p) => pm === NEG || num(p.ts) >= pm);
  if (!eligible.length) eligible = events; // inconsistent sidecar: never drop progress entirely
  eligible.sort((x, y) => cmpEvent(y, x)); // best first
  const frontier = [];
  let maxTs = NEG;
  for (const p of eligible) {
    if (frontier.length && !(num(p.ts) > maxTs)) continue; // dominated (or a duplicate)
    frontier.push(p);
    maxTs = Math.max(maxTs, num(p.ts));
  }
  return { progress: frontier[0], pm, pf: frontier.slice(1) };
}

function cmpLatest(x, y) {
  if (!isObj(x) || !isObj(y)) return cmp(isObj(x) ? 1 : 0, isObj(y) ? 1 : 0);
  return cmp(num(x.chap), num(y.chap)) || cmp(num(x.ts), num(y.ts))
    || cmp(canonical(x), canonical(y)) || cmp(JSON.stringify(x), JSON.stringify(y));
}
function cmpNext(x, y) {
  if (!isObj(x) || !isObj(y)) return cmp(isObj(x) ? 1 : 0, isObj(y) ? 1 : 0);
  return cmp(num(x.ts), num(y.ts)) || cmp(canonical(x), canonical(y)) || cmp(JSON.stringify(x), JSON.stringify(y));
}

/**
 * Merge two versions of the same entry.
 * @returns {{entry: object, meta: {r:number, pe:number}}}
 */
export function mergeEntry(a, aMeta, b, bMeta) {
  if (!a) return { entry: b, meta: metaOf(b, bMeta) };
  if (!b) return { entry: a, meta: metaOf(a, aMeta) };
  const ma = metaOf(a, aMeta), mb = metaOf(b, bMeta);
  const aWins = compareRest(a, ma, b, mb) >= 0;
  let out = aWins ? a : b;

  const { progress, pm, pf } = mergeProgress(a.progress, ma, b.progress, mb);
  const latest = cmpLatest(a.latest, b.latest) >= 0 ? a.latest : b.latest;
  const next = cmpNext(a.next, b.next) >= 0 ? a.next : b.next;

  if (progress !== undefined && out.progress !== progress) out = withField(out, 'progress', progress);
  if (latest !== undefined && out.latest !== latest) out = withField(out, 'latest', latest);
  if (next !== undefined && out.next !== next) out = withField(out, 'next', next);
  const ts = Math.max(num(a.ts), num(b.ts));
  if (ts !== NEG && out.ts !== ts) out = withField(out, 'ts', ts);
  const meta = { r: Math.max(ma.r, mb.r), u: Math.max(ma.u, mb.u) };
  if (pm !== NEG) meta.pm = pm;
  if (pf.length) meta.pf = pf;
  return { entry: out, meta };
}

// ---------------------------------------------------------------------------------------
// Library-level merge
//
// A library (in memory) is:
//   { order: string[], entries: Map<id, object>, meta: Map<id, {r,pm?,u,pf?}>,
//     tombs: Map<id, number>, labels: {folder:{}, type:{}, tag:{}} }
// Labels: kind -> key -> { name: string, ts: number }

export function emptyLabels() { return { folder: {}, type: {}, tag: {} }; }

export function mergeLabels(a = emptyLabels(), b = emptyLabels()) {
  const out = emptyLabels();
  for (const kind of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const x = (a && a[kind]) || {}, y = (b && b[kind]) || {};
    const o = {};
    for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
      const p = x[k], q = y[k];
      if (!p) o[k] = q;
      else if (!q) o[k] = p;
      else o[k] = (cmp(num(p.ts), num(q.ts)) || cmp(canonical(p), canonical(q))) >= 0 ? p : q;
    }
    out[kind] = o;
  }
  return out;
}

/**
 * Merge two libraries. Content (entries, meta, tombstones, labels) merges symmetrically.
 * Layout (order, MangaPin top-level keys, orphan covers) is last-writer-wins by layoutTs,
 * which only imports set; on a tie `base` wins (sync passes the server as base, so every
 * device converges on the server's order). Ids missing from the winning order are appended
 * in the other side's order.
 */
export function mergeLibraries(base, other) {
  const entries = new Map();
  const meta = new Map();
  const tombs = new Map();
  const ids = new Set([...base.entries.keys(), ...other.entries.keys(), ...base.tombs.keys(), ...other.tombs.keys()]);
  for (const id of ids) {
    const t = Math.max(num(base.tombs.get(id)), num(other.tombs.get(id)));
    if (t !== NEG) tombs.set(id, t);
    const be = base.entries.get(id), oe = other.entries.get(id);
    if (!be && !oe) continue;
    const m = mergeEntry(be, base.meta.get(id), oe, other.meta.get(id));
    if (t !== NEG && t > editTs(m.entry, m.meta)) continue; // deleted
    entries.set(id, m.entry);
    meta.set(id, m.meta);
  }
  const [first, second] = num(other.layoutTs) > num(base.layoutTs) ? [other, base] : [base, other];
  const order = [];
  const placed = new Set();
  for (const id of [...first.order, ...second.order, ...entries.keys()]) {
    if (entries.has(id) && !placed.has(id)) { placed.add(id); order.push(id); }
  }
  return {
    order, entries, meta, tombs, labels: mergeLabels(base.labels, other.labels),
    top: first.top || second.top || null,
    keepImgs: [...(first.keepImgs || [])],
    layoutTs: Math.max(num(base.layoutTs), num(other.layoutTs), 0),
  };
}

/** Order-independent fingerprint of a library's content (entries + meta + tombs + labels). */
export function libraryFingerprint(lib) {
  const ids = [...lib.entries.keys()].sort();
  return canonical({
    e: ids.map((id) => [id, lib.entries.get(id), metaOf(lib.entries.get(id), lib.meta.get(id))]),
    t: [...lib.tombs.entries()].sort((x, y) => cmp(x[0], y[0])),
    l: lib.labels,
  });
}
