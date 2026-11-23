// Safe DOM construction. Entry data (names, URLs) comes from websites: it only ever goes
// into textContent / validated attributes — never innerHTML.

export const api = globalThis.browser ?? globalThis.chrome;

/** http(s) only; anything else (javascript:, data:, chrome:) becomes null. */
export function safeHttpUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null;
  } catch { return null; }
}

/**
 * h('div', {class:'x', text:'hi', on:{click: fn}, attrs:{title:'t'}, href, src, value}, ...children)
 * children: Node | string | number | null | false | arrays thereof
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'attrs') for (const [a, av] of Object.entries(v)) { if (av !== undefined && av !== null && av !== false) el.setAttribute(a, av === true ? '' : String(av)); }
    else if (k === 'dataset') for (const [a, av] of Object.entries(v)) el.dataset[a] = String(av);
    else if (k === 'href') { const u = safeHttpUrl(v); if (u) el.href = u; }
    else if (k === 'src') { if (typeof v === 'string' && (v.startsWith('blob:') || safeHttpUrl(v))) el.src = v; }
    else if (k === 'value') el.value = String(v);
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'multiple' || k === 'required') el[k] = !!v;
    else if (/^(type|name|placeholder|id|for|min|max|step|title|role|autocomplete|accept|tabindex|aria-[a-z]+|rel|target)$/.test(k)) el.setAttribute(k, String(v));
    else throw new Error('h(): unsupported prop ' + k);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export async function send(type, payload = {}) {
  const res = await api.runtime.sendMessage({ type, ...payload });
  if (!res) throw new Error('no response from background');
  if (!res.ok) throw new Error(res.error || 'background error');
  return res.result;
}

export function fmtChap(c) {
  if (typeof c !== 'number' || !Number.isFinite(c)) return '–';
  return Number.isInteger(c) ? String(c) : String(Math.round(c * 100) / 100);
}

export function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const blobCache = new Map();
/** base64 WebP -> blob: URL (cached per key). */
export function coverUrl(key, b64) {
  if (!b64) return null;
  if (blobCache.has(key)) return blobCache.get(key);
  const bin = atob(b64.replace(/^data:[^,]*,/, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/webp' }));
  blobCache.set(key, url);
  return url;
}

export function labelName(labels, kind, value) {
  const l = labels && labels[kind] && labels[kind][String(value)];
  return l && l.name ? l.name : null;
}

export function folderName(labels, f) {
  return labelName(labels, 'folder', f) || `Folder ${f}`;
}

export function syncSummary(sync, cfg, hasToken) {
  if (!cfg.davUrl || !cfg.user || !hasToken) return { cls: 'off', text: 'Sync not set up' };
  if (sync.running) return { cls: 'busy', text: 'Syncing…' };
  if (sync.lastError && (sync.lastAttempt || 0) >= (sync.lastOk || 0)) return { cls: 'err', text: 'Sync failed: ' + sync.lastError };
  const pending = sync.dirty ? ' · changes pending' : '';
  return { cls: sync.dirty ? 'pending' : 'ok', text: `Synced ${ago(sync.lastOk)}${pending}` };
}
