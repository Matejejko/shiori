// Persistence on top of a chrome.storage.local-like area ({get,set,remove}).
//
// Layout (all values JSON-safe; entries are stored as *strings* because
// chrome.storage.local returns objects with alphabetically sorted keys):
//   e:<id>      raw JSON string of the entry, verbatim
//   lib         { order, meta:{id:{r,b?,f?,pm?,u,pf?,rs?}}, tombs:{id:ts}, labels, layoutTs }
//   c:<key>     base64 WebP for cover key "local:<bytes>:<md5>.webp"
//   cidx        array of cover keys present locally
//   cfg         settings (never contains the token)
//   secret      { token }  — local only, never synced, never logged
//   sync        sync bookkeeping { etag, lastOk, lastAttempt, lastError, syncedSeq, dirsOk, remoteCovers }
//   dseq        local change counter (bumped by every non-silent library save)

import { emptyLabels } from './merge.js';

const EMPTY_INDEX = () => ({ order: [], meta: {}, tombs: {}, labels: emptyLabels(), days: {}, seen: undefined, layoutTs: 0 });

export const DEFAULT_CFG = {
  davUrl: '',          // full WebDAV root of the user's space, e.g. https://host/remote.php/webdav/
  user: '',
  autoSync: true,
  releaseChecks: true,
  releaseFolder: 1,    // folder whose series get release checks
};

export class Store {
  constructor(area) {
    this.area = area;
    this._lock = Promise.resolve();
    this._small = Promise.resolve(); // serialises read-modify-write of small shared keys (cidx, sync)
    this.onChange = null; // (what) => void, set by background to schedule sync / badge
  }

  /** Serialize all library mutations (tracker, sync, import, UI edits). */
  withLock(fn) {
    const run = this._lock.then(fn, fn);
    this._lock = run.catch(() => {});
    return run;
  }

  _serial(fn) {
    const run = this._small.then(fn, fn);
    this._small = run.catch(() => {});
    return run;
  }

  async loadIndex() {
    const { lib } = await this.area.get('lib');
    return { ...EMPTY_INDEX(), ...(lib || {}) };
  }

  /** Load the full library: { order, entries:Map<id,obj>, meta:Map, tombs:Map, labels, layoutTs } */
  async loadLibrary() {
    const idx = await this.loadIndex();
    const keys = idx.order.map((id) => 'e:' + id);
    const got = keys.length ? await this.area.get(keys) : {};
    const entries = new Map();
    const order = [];
    for (const id of idx.order) {
      const raw = got['e:' + id];
      if (typeof raw !== 'string') continue;
      entries.set(id, JSON.parse(raw));
      order.push(id);
    }
    return {
      order,
      entries,
      meta: new Map(Object.entries(idx.meta || {})),
      tombs: new Map(Object.entries(idx.tombs || {})),
      labels: idx.labels || emptyLabels(),
      days: idx.days || {},
      // read-before-pin memory: synced since it moved into the library; older versions kept it under 'seen'
      seen: idx.seen || (await this.area.get('seen')).seen || {},
      layoutTs: idx.layoutTs || 0,
    };
  }

  /** Persist `lib`, writing only entries whose serialized form changed. Returns #entry writes.
   *  Non-silent saves mark the library dirty (bumps sync.seq) so a sync gets scheduled. */
  async saveLibrary(lib, { silent = false } = {}) {
    const idx = await this.loadIndex();
    const oldIds = new Set(idx.order);
    const keys = [...lib.entries.keys()].map((id) => 'e:' + id);
    const current = keys.length ? await this.area.get(keys) : {};
    const writes = {};
    let n = 0;
    for (const [id, obj] of lib.entries) {
      const raw = JSON.stringify(obj);
      if (current['e:' + id] !== raw) { writes['e:' + id] = raw; n++; }
    }
    const removed = [...oldIds].filter((id) => !lib.entries.has(id)).map((id) => 'e:' + id);
    writes.lib = {
      order: lib.order.filter((id) => lib.entries.has(id)),
      meta: Object.fromEntries([...lib.meta].filter(([id]) => lib.entries.has(id))),
      tombs: Object.fromEntries(lib.tombs),
      labels: lib.labels || emptyLabels(),
      days: lib.days || {},
      seen: lib.seen || {},
      layoutTs: lib.layoutTs || 0,
    };
    if (!silent) {
      const { dseq } = await this.area.get('dseq');
      writes.dseq = (dseq || 0) + 1; // separate key so it never races sync-state writes
    }
    await this.area.set(writes);
    // + 'seen': the old, unsynced home of the read-before-pin memory (now in the index)
    await this.area.remove([...removed, 'seen']);
    // covers no entry uses any more (deleted series) go too; the server keeps every cover, so
    // snapshots stay restorable. (Callers store a new cover before the entry that uses it.)
    const used = new Set([...lib.entries.values()].map((e) => e && e.img));
    const unused = (await this.coverKeys()).filter((k) => !used.has(k));
    if (unused.length) await this.removeCovers(unused);
    if (this.onChange) this.onChange(silent ? 'library-synced' : 'library');
    return n + removed.length;
  }

  async getEntry(id) {
    const r = await this.area.get('e:' + id);
    return typeof r['e:' + id] === 'string' ? JSON.parse(r['e:' + id]) : null;
  }

  // ---- covers --------------------------------------------------------------------------
  async coverKeys() {
    const { cidx } = await this.area.get('cidx');
    return Array.isArray(cidx) ? cidx : [];
  }
  async getCover(key) {
    const r = await this.area.get('c:' + key);
    return r['c:' + key];
  }
  async getCovers(keys) {
    if (!keys.length) return new Map();
    const r = await this.area.get(keys.map((k) => 'c:' + k));
    const out = new Map();
    for (const k of keys) if (typeof r['c:' + k] === 'string') out.set(k, r['c:' + k]);
    return out;
  }
  /** @param {Map<string,string>|Array<[string,string]>} covers key -> base64 */
  putCovers(covers) {
    const list = [...covers];
    if (!list.length) return Promise.resolve();
    return this._serial(async () => {
      const have = new Set(await this.coverKeys());
      const writes = {};
      for (const [k, v] of list) { writes['c:' + k] = v; have.add(k); }
      writes.cidx = [...have];
      await this.area.set(writes);
    });
  }
  removeCovers(keys) {
    if (!keys.length) return Promise.resolve();
    return this._serial(async () => {
      const drop = new Set(keys);
      const cidx = (await this.coverKeys()).filter((k) => !drop.has(k));
      await this.area.remove(keys.map((k) => 'c:' + k));
      await this.area.set({ cidx });
    });
  }

  // ---- settings / secret / sync state --------------------------------------------------
  async getConfig() {
    const { cfg } = await this.area.get('cfg');
    return { ...DEFAULT_CFG, ...(cfg || {}) };
  }
  async setConfig(patch) {
    const cfg = { ...(await this.getConfig()), ...patch };
    delete cfg.token; // never let the token land in cfg
    await this.area.set({ cfg });
    return cfg;
  }
  /** Random id of this browser profile (the reading log counts per device). Never synced as a secret. */
  async deviceId() {
    const { device } = await this.area.get('device');
    if (typeof device === 'string' && device) return device;
    const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
    await this.area.set({ device: id });
    return id;
  }
  async getToken() {
    const { secret } = await this.area.get('secret');
    return (secret && secret.token) || '';
  }
  async setToken(token) {
    await this.area.set({ secret: { token: String(token || '') } });
  }
  /** Sync bookkeeping. `seq` counts local changes; `dirty` = changes not yet synced. */
  async getSyncState() {
    const { sync, dseq } = await this.area.get(['sync', 'dseq']);
    const st = { etag: null, lastOk: 0, lastAttempt: 0, lastError: '', syncedSeq: 0, dirsOk: false, remoteCovers: [], ...(sync || {}) };
    st.seq = dseq || 0;
    st.dirty = st.seq > st.syncedSeq;
    return st;
  }
  setSyncState(patch) {
    return this._serial(async () => {
      const { sync } = await this.area.get('sync');
      const next = { ...(sync || {}), ...patch };
      delete next.seq; delete next.dirty; // derived
      await this.area.set({ sync: next });
      return next;
    });
  }
}

/** In-memory area that mimics chrome.storage.local, including its key sorting. */
export class MemoryArea {
  constructor() { this.data = new Map(); }
  static clone(v) {
    // Chrome round-trips through base::Value: dictionaries come back with sorted keys.
    const sortDeep = (x) => {
      if (Array.isArray(x)) return x.map(sortDeep);
      if (x && typeof x === 'object') {
        const o = {};
        for (const k of Object.keys(x).sort()) o[k] = sortDeep(x[k]);
        return o;
      }
      return x;
    };
    return v === undefined ? undefined : sortDeep(JSON.parse(JSON.stringify(v)));
  }
  async get(keys) {
    const out = {};
    if (keys == null) { for (const [k, v] of this.data) out[k] = MemoryArea.clone(v); return out; }
    for (const k of Array.isArray(keys) ? keys : [keys]) if (this.data.has(k)) out[k] = MemoryArea.clone(this.data.get(k));
    return out;
  }
  async set(obj) { for (const [k, v] of Object.entries(obj)) this.data.set(k, MemoryArea.clone(v)); }
  async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) this.data.delete(k); }
}
