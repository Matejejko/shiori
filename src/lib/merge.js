// Deterministic merge of entries and libraries (entries keep MangaPin's field names).
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
//   rest     — every other field, one by one: the side with the newer edit time of that
//              field wins (sidecar `f`, else `b`/`r`; defaults to entry.ts). Release checks and
//              tracking bump entry.ts but not these, so they can't clobber a tag/folder edit
//              made on another machine, and edits of different fields on two devices both stay.
//   ts       — max
// Every choice is a join in a semilattice (max over a total order, or set union + frontier),
// which makes the merge commutative, associative and idempotent (property-tested).
//
// Entries are never reshaped: the winner's object is copied with its own key order and only
// the three group fields (+ts) are replaced in place (or inserted in MangaPin's field order).
//
// Sidecar meta per id: { r, f?, pm?, pf?, rs? } — base edit time of the rest fields (defaults to
// entry.ts), edit times of single rest fields that differ from it, manual-correction time, extra
// progress frontier events, restore time (the only thing that beats an older tombstone). It lives
// in Shiori's storage and library.json, next to the entries (never inside them).

import { withField } from './mangapin.js';
import { slugKey, getAdapter } from './adapters.js';
import { SEEN_MAX, SEEN_TTL } from './tracker.js';

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

/**
 * Normalized bookkeeping of one series. Also reads older records: `b` held the base time while
 * `r` was bumped on every edit (the edited fields are in `f` either way, so `b` is the base), and
 * `u` (last activity) is gone: a delete is final unless restored, so only `rs` matters for it.
 */
export function metaOf(entry, meta) {
  const r = typeof meta?.b === 'number' ? meta.b : typeof meta?.r === 'number' ? meta.r : num(entry?.ts) === NEG ? 0 : entry.ts;
  // pm: manual-correction time (older builds called it `pe`, with 0 meaning "none")
  const pm = typeof meta?.pm === 'number' ? meta.pm : typeof meta?.pe === 'number' && meta.pe > 0 ? meta.pe : NEG;
  const rs = typeof meta?.rs === 'number' ? meta.rs : NEG;
  const pf = Array.isArray(meta?.pf) ? meta.pf.filter((x) => isObj(x)) : [];
  const out = { r };
  // a field time equal to the base says nothing: drop it, so equal states compare equal
  const f = isObj(meta?.f) ? Object.entries(meta.f).filter(([k, t]) => typeof t === 'number' && t !== r && !GROUP.has(k)) : [];
  if (f.length) out.f = Object.fromEntries(f.sort((x, y) => cmp(x[0], y[0])));
  if (pm !== NEG) out.pm = pm;
  if (pf.length) out.pf = pf;
  if (rs !== NEG) out.rs = rs;
  return out;
}

/** The time a delete of this series gets: after its last restore, and not before `now`. */
export const tombTime = (meta, now = 0) => Math.max(now, (meta.rs ?? 0) + 1);

function compareRest(a, ma, b, mb) {
  return cmp(ma.r, mb.r)
    || cmp(canonical(restOf(a)), canonical(restOf(b)))
    || cmp(JSON.stringify(restOf(a)), JSON.stringify(restOf(b)))
    || cmp(JSON.stringify(a), JSON.stringify(b));
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function withoutField(o, key) {
  const out = {};
  for (const k of Object.keys(o)) if (k !== key) Object.defineProperty(out, k, { value: o[k], enumerable: true, writable: true, configurable: true });
  return out;
}

/** Edit time of one rest field: its own (meta.f), else the base time of the fields without one. */
export const fieldTime = (m, k) => (m.f && typeof m.f[k] === 'number' ? m.f[k] : m.r);

/**
 * Rest fields merge one by one: each is a last-writer-wins register (time, then presence,
 * then value as tie-breaks), so an offline folder change on one device and a tag change on
 * another both survive. Times are kept as base (r, for every field without its own) + f.
 */
function mergeRestFields(a, ma, b, mb) {
  const keys = new Set();
  for (const o of [a, b, ma.f || {}, mb.f || {}]) for (const k of Object.keys(o)) if (!GROUP.has(k)) keys.add(k);
  const base = Math.max(ma.r, mb.r);
  const pick = new Map(), f = {};
  for (const k of [...keys].sort()) {
    const ta = fieldTime(ma, k), tb = fieldTime(mb, k);
    const c = cmp(ta, tb) || cmp(hasOwn(a, k) ? 1 : 0, hasOwn(b, k) ? 1 : 0)
      || cmp(canonical(a[k]), canonical(b[k])) || cmp(JSON.stringify(a[k]) ?? '', JSON.stringify(b[k]) ?? '');
    pick.set(k, c >= 0 ? 'a' : 'b');
    const t = Math.max(ta, tb);
    if (t !== base) f[k] = t;
  }
  return { pick, f, base };
}

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
  const rest = mergeRestFields(a, ma, b, mb);
  for (const [k, side] of rest.pick) {
    const src = side === 'a' ? a : b;
    if (src === out) continue;
    if (hasOwn(src, k)) { if (!hasOwn(out, k) || canonical(out[k]) !== canonical(src[k]) || JSON.stringify(out[k]) !== JSON.stringify(src[k])) out = withField(out, k, src[k]); }
    else if (hasOwn(out, k)) out = withoutField(out, k);
  }

  const { progress, pm, pf } = mergeProgress(a.progress, ma, b.progress, mb);
  // only objects compete; with neither one an object, the winning copy keeps its own (order-free)
  const latest = isObj(a.latest) || isObj(b.latest) ? (cmpLatest(a.latest, b.latest) >= 0 ? a.latest : b.latest) : undefined;
  const next = isObj(a.next) || isObj(b.next) ? (cmpNext(a.next, b.next) >= 0 ? a.next : b.next) : undefined;

  if (progress !== undefined && out.progress !== progress) out = withField(out, 'progress', progress);
  if (latest !== undefined && out.latest !== latest) out = withField(out, 'latest', latest);
  if (next !== undefined && out.next !== next) out = withField(out, 'next', next);
  const ts = Math.max(num(a.ts), num(b.ts));
  if (ts !== NEG && out.ts !== ts) out = withField(out, 'ts', ts);
  const meta = { r: rest.base };
  if (Object.keys(rest.f).length) meta.f = rest.f;
  if (pm !== NEG) meta.pm = pm;
  if (pf.length) meta.pf = pf;
  const rs = Math.max(ma.rs ?? NEG, mb.rs ?? NEG);
  if (rs !== NEG) meta.rs = rs;
  return { entry: out, meta };
}

// ---------------------------------------------------------------------------------------
// Library-level merge
//
// A library (in memory) is:
//   { order: string[], entries: Map<id, object>, meta: Map<id, {r,pm?,u,pf?}>,
//     tombs: Map<id, number>, labels: {folder:{}, type:{}, tag:{}} }
// Labels: kind -> key -> { name: string, ts: number }

// Labels: folder names only ({ folder: { '<number>': {name, ts} } }); older libraries also had
// type and tag names, which are no longer used (tags are names themselves).
export function emptyLabels() { return { folder: {} }; }

/**
 * Series read but not pinned ({ seriesKey: {chap, slug?, ts} }, see tracker.noteSeen), synced so
 * pinning on another device starts at the right chapter and stats agree. Per series: the furthest
 * chapter (with its slug) and the latest time. Then, deterministically from the merged set alone:
 * entries older than SEEN_TTL before its newest one go, and only the newest SEEN_MAX stay.
 */
export function mergeSeen(a, b) {
  const out = new Map();
  for (const src of [a, b]) {
    if (!isObj(src)) continue;
    for (const [k, r] of Object.entries(src)) {
      if (!isObj(r) || typeof r.chap !== 'number' || typeof r.ts !== 'number') continue;
      if (!getAdapter(k.split('|')[0])) continue; // known manga sites only (see background tracking)
      const o = out.get(k);
      if (!o) { out.set(k, r); continue; }
      const best = r.chap > o.chap || (r.chap === o.chap && canonical(r) > canonical(o)) ? r : o;
      const m = { chap: best.chap };
      if (best.slug !== undefined) m.slug = best.slug;
      m.ts = Math.max(o.ts, r.ts);
      out.set(k, m);
    }
  }
  const newest = Math.max(0, ...[...out.values()].map((r) => r.ts));
  const keep = [...out].filter(([, r]) => r.ts > newest - SEEN_TTL)
    .sort((x, y) => cmp(y[1].ts, x[1].ts) || cmp(x[0], y[0])).slice(0, SEEN_MAX);
  return Object.fromEntries(keep.sort((x, y) => cmp(x[0], y[0])));
}

/**
 * Reading log: chapters read per device per local day, { device: { 'YYYY-MM-DD': n } }. Each
 * device only ever raises its own counts, so the merge is a max per (device, day) and the
 * library's total for a day is the sum over devices. ~20 bytes per device per day read.
 */
export function mergeDays(a, b) {
  const out = {};
  for (const src of [a, b]) {
    if (!isObj(src)) continue;
    for (const [dev, days] of Object.entries(src)) {
      if (!isObj(days)) continue;
      const o = out[dev] || (out[dev] = {});
      for (const [d, n] of Object.entries(days)) if (typeof n === 'number' && n > (o[d] ?? 0)) o[d] = n;
    }
  }
  const sorted = {};
  for (const dev of Object.keys(out).sort()) sorted[dev] = Object.fromEntries(Object.keys(out[dev]).sort().map((d) => [d, out[dev][d]]));
  return sorted;
}

export function mergeLabels(a = emptyLabels(), b = emptyLabels()) {
  const out = emptyLabels();
  for (const kind of ['folder']) {
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
 * Layout (order) is last-writer-wins by layoutTs,
 * which only imports set; on a tie `base` wins (sync passes the server as base, so every
 * device converges on the server's order). Ids missing from the winning order are appended
 * in the other side's order.
 */
export function mergeLibraries(base, other) {
  const entries = new Map();
  const meta = new Map();
  const tombs = new Map();
  const dead = new Map(); // id -> merged copy that a tombstone beat (folded into a live duplicate, if any)
  const ids = new Set([...base.entries.keys(), ...other.entries.keys(), ...base.tombs.keys(), ...other.tombs.keys()]);
  for (const id of ids) {
    const t = Math.max(num(base.tombs.get(id)), num(other.tombs.get(id)));
    if (t !== NEG) tombs.set(id, t);
    const be = base.entries.get(id), oe = other.entries.get(id);
    if (!be && !oe) continue;
    const m = mergeEntry(be, base.meta.get(id), oe, other.meta.get(id));
    // a delete is final everywhere: reads and edits on a device that had not seen it yet do not
    // bring the series back; only an explicit restore (replace import) made after it does
    if (t !== NEG && t > (m.meta.rs ?? NEG)) { dead.set(id, m); continue; }
    entries.set(id, m.entry);
    meta.set(id, m.meta);
  }
  const folds = new Set([...(base.folds || []), ...(other.folds || [])]);
  dedupeSeries(entries, meta, tombs, dead, folds);
  const [first, second] = num(other.layoutTs) > num(base.layoutTs) ? [other, base] : [base, other];
  const order = [];
  const placed = new Set();
  for (const id of [...first.order, ...second.order, ...entries.keys()]) {
    if (entries.has(id) && !placed.has(id)) { placed.add(id); order.push(id); }
  }
  return {
    order, entries, meta, tombs, folds, labels: mergeLabels(base.labels, other.labels), days: mergeDays(base.days, other.days), seen: mergeSeen(base.seen, other.seen),
    layoutTs: Math.max(num(base.layoutTs), num(other.layoutTs), 0),
  };
}

/**
 * Same series on the same site, whatever its id (volatile slug parts ignored). An entry without
 * a usable slug can't be matched to anything, so it is only ever itself.
 */
export const seriesKey = (e) => { const k = slugKey(e.siteId, e.slug); return k ? `${e.siteId}|${k}` : `id:${e.id}`; };

/**
 * Never keep two entries for one series (two devices pinned it, or an import brought it in
 * under another id): the smallest live id survives — every device picks the same one — the
 * others are merged into it field by field, tombstoned and recorded in `folds`. Stale copies of
 * a folded id (`dead`: a device that was offline at the fold still reads on it) are merged into
 * the survivor too, so those reads are not lost. A copy you deleted yourself is not in `folds`:
 * its data stays deleted, even if you pin the series again. Mutates the maps and the set.
 */
export function dedupeSeries(entries, meta, tombs, dead = new Map(), folds = new Set()) {
  const groups = new Map();
  for (const [id, e] of entries) {
    const k = seriesKey(e);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(id);
  }
  const fold = (keep, dup, dm) => {
    const m = mergeEntry(entries.get(keep), meta.get(keep), withField(dup, 'id', keep), dm);
    entries.set(keep, m.entry); meta.set(keep, m.meta);
  };
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    ids.sort();
    const keep = ids[0];
    for (const id of ids.slice(1)) {
      const dup = entries.get(id), dm = metaOf(dup, meta.get(id));
      fold(keep, dup, dm);
      // newer than anything that copy has seen, so it stays deleted on every device
      tombs.set(id, Math.max(num(tombs.get(id)), tombTime(dm)));
      folds.add(id);
      entries.delete(id); meta.delete(id);
    }
  }
  for (const [id, m] of [...dead].sort((a, b) => cmp(a[0], b[0]))) {
    if (!folds.has(id)) continue;
    const ids = groups.get(seriesKey(m.entry));
    if (ids && ids[0] !== id) fold(ids[0], m.entry, m.meta);
  }
}

/** Order-independent fingerprint of a library's content (entries + meta + tombs + labels). */
export function libraryFingerprint(lib) {
  const ids = [...lib.entries.keys()].sort();
  return canonical({
    e: ids.map((id) => [id, lib.entries.get(id), metaOf(lib.entries.get(id), lib.meta.get(id))]),
    t: [...lib.tombs.entries()].sort((x, y) => cmp(x[0], y[0])),
    f: [...(lib.folds || [])].sort(),
    l: lib.labels,
    d: mergeDays(lib.days, {}),
    s: mergeSeen(lib.seen, {}),
  });
}
