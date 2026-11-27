// Minimal WebDAV client on fetch(). Runs in the background worker only (host permissions
// make the requests CORS-exempt). The token is only ever placed in the Authorization header;
// errors never echo request headers.

export class DavError extends Error {
  constructor(message, status = 0, kind = 'http') {
    super(message);
    this.name = 'DavError';
    this.status = status;
    this.kind = kind; // 'http' | 'network' | 'auth' | 'conflict' | 'format'
  }
}

function utf8b64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const encodePath = (p) => p.split('/').map((seg) => encodeURIComponent(seg)).join('/');

export class WebDav {
  /**
   * @param {object} o
   * @param {string} o.url   WebDAV root of the user's space, e.g. https://host/remote.php/webdav/
   * @param {string} o.user
   * @param {string} o.token app token (HTTP Basic password)
   * @param {typeof fetch} [o.fetch]
   * @param {number} [o.timeoutMs]
   */
  constructor({ url, user, token, fetch: f, timeoutMs = 30000 }) {
    if (!url) throw new DavError('No server URL configured', 0, 'config');
    let u;
    try { u = new URL(url); } catch { throw new DavError('Server URL is not a valid URL', 0, 'config'); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new DavError('Server URL must be http(s)', 0, 'config');
    // Basic auth sends the token in clear text over http: only allowed for this machine
    if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new DavError('Server URL must use https:// (the app token would travel unencrypted)', 0, 'config');
    this.root = u.href.endsWith('/') ? u.href : u.href + '/';
    this.auth = 'Basic ' + utf8b64(`${user}:${token}`);
    this.fetch = f || globalThis.fetch.bind(globalThis);
    this.timeoutMs = timeoutMs;
  }

  url(path) { return this.root + encodePath(path.replace(/^\/+/, '')); }

  async request(method, path, { headers = {}, body, okStatuses } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(this.url(path), {
        method,
        headers: { Authorization: this.auth, ...headers },
        body,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'follow',
        signal: ctrl.signal,
      });
    } catch (err) {
      const reason = err && err.name === 'AbortError' ? 'timed out' : 'network/TLS error';
      throw new DavError(`${method} ${path}: ${reason} (server unreachable, offline, or certificate not trusted)`, 0, 'network');
    } finally {
      clearTimeout(timer);
    }
    this.lastDate = res.headers.get('date'); // the server's clock, from any answer (see sync.checkClock)
    if (res.status === 401 || res.status === 403) {
      throw new DavError(`${method} ${path}: ${res.status} — check username and app token`, res.status, 'auth');
    }
    if (okStatuses && !okStatuses.includes(res.status)) {
      const kind = res.status === 412 ? 'conflict' : 'http';
      throw new DavError(`${method} ${path}: HTTP ${res.status}`, res.status, kind);
    }
    return res;
  }

  /** @returns {Promise<{text:string, etag:string|null}|null>} null if missing */
  async getText(path) {
    const res = await this.request('GET', path, { okStatuses: [200, 404] });
    if (res.status === 404) return null;
    return { text: await res.text(), etag: res.headers.get('etag'), date: res.headers.get('date') };
  }

  async getBytes(path) {
    const res = await this.request('GET', path, { okStatuses: [200, 404] });
    if (res.status === 404) return null;
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Conditional PUT. Pass ifMatch (an ETag) to update, or ifNoneMatch:'*' to create.
   * Throws DavError kind 'conflict' on 412.
   */
  async put(path, body, { ifMatch, ifNoneMatch, contentType = 'application/octet-stream' } = {}) {
    const headers = { 'Content-Type': contentType };
    if (ifMatch) headers['If-Match'] = ifMatch;
    if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
    const res = await this.request('PUT', path, { headers, body, okStatuses: [200, 201, 204] });
    return { status: res.status, etag: res.headers.get('etag') };
  }

  /** Create a collection; existing is fine. */
  async mkcol(path) {
    const res = await this.request('MKCOL', path.endsWith('/') ? path : path + '/', { okStatuses: [201, 405, 301] });
    return res.status === 201;
  }

  async delete(path) {
    const res = await this.request('DELETE', path, { okStatuses: [200, 204, 404] });
    return res.status !== 404;
  }

  async head(path) {
    const res = await this.request('HEAD', path, { okStatuses: [200, 404] });
    return res.status === 200 ? { etag: res.headers.get('etag'), size: Number(res.headers.get('content-length')) } : null;
  }

  /** PROPFIND; returns [{name, href, etag, size, dir}] for the children (Depth 1) or the item (Depth 0). */
  async propfind(path, depth = 1) {
    const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>';
    const res = await this.request('PROPFIND', path, {
      headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' },
      body,
      okStatuses: [207, 404],
    });
    if (res.status === 404) return null;
    return parseMultistatus(await res.text(), this.url(path));
  }
}

const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');

/** Namespace-prefix-agnostic multistatus parser (no DOMParser in service workers). */
export function parseMultistatus(xml, requestUrl) {
  const out = [];
  const tag = (name) => new RegExp(`<(?:[A-Za-z][\\w.-]*:)?${name}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[A-Za-z][\\w.-]*:)?${name}>)`, 'i');
  const reqPath = new URL(requestUrl).pathname.replace(/\/+$/, '');
  for (const m of xml.matchAll(/<(?:[A-Za-z][\w.-]*:)?response\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?response>/gi)) {
    const block = m[1];
    const hrefM = tag('href').exec(block);
    if (!hrefM || hrefM[1] === undefined) continue;
    const href = decodeXml(hrefM[1].trim());
    let pathname;
    try { pathname = new URL(href, requestUrl).pathname; } catch { continue; }
    const clean = pathname.replace(/\/+$/, '');
    // only successful propstat
    const okStat = /<(?:[A-Za-z][\w.-]*:)?propstat\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?propstat>/gi;
    let etag = null, size = null, dir = false;
    for (const ps of block.matchAll(okStat)) {
      const st = tag('status').exec(ps[1]);
      if (st && st[1] && !/\s2\d\d\s/.test(st[1])) continue;
      const e = tag('getetag').exec(ps[1]);
      if (e && e[1]) etag = decodeXml(e[1].trim());
      const l = tag('getcontentlength').exec(ps[1]);
      if (l && l[1]) size = Number(l[1].trim());
      const rt = tag('resourcetype').exec(ps[1]);
      if (rt && rt[1] && /collection\b/i.test(rt[1])) dir = true;
    }
    const segs = clean.split('/');
    let name;
    try { name = decodeURIComponent(segs[segs.length - 1]); } catch { name = segs[segs.length - 1]; }
    out.push({ href, name, etag, size, dir, self: clean === reqPath });
  }
  return out;
}

/**
 * The WebDAV folder for what the user typed: the address as given, or — for a bare server
 * address like https://cloud.example — the standard OpenCloud / Nextcloud / ownCloud paths.
 * Resolves to the first that answers; throws the most useful error otherwise.
 */
export async function findDavRoot({ url, user, token, fetch }) {
  let u;
  try { u = new URL(url); } catch { throw new DavError('Server URL is not a valid URL', 0, 'config'); }
  const tries = [u.href];
  if (u.pathname === '/' && !u.search) tries.push(`${u.origin}/remote.php/webdav/`, `${u.origin}/dav/files/${encodeURIComponent(user)}/`);
  let first = null;
  for (const t of tries) {
    try {
      if (await new WebDav({ url: t, user, token, fetch }).propfind('', 0)) return t;
      first ||= new DavError('WebDAV folder not found (404) — check the URL', 404);
    } catch (e) {
      if (e.kind !== 'http') throw e; // network, certificate, wrong token: trying other paths won't help
      first ||= e;
    }
  }
  if (first.status === 405) throw new DavError('That address is not a WebDAV folder (HTTP 405). For OpenCloud it is https://<server>/remote.php/webdav/', 405);
  throw first;
}
