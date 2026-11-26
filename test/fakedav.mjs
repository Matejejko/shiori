// In-process WebDAV server as a fetch() implementation, modelled on what OpenCloud 9.2
// actually does (see test/opencloud/NOTES.md):
//  - strong quoted ETags, new ETag on every PUT
//  - If-Match stale / on missing file -> 412;  If-None-Match: * is IGNORED (overwrites)
//  - PUT into a missing folder -> 409; MKCOL existing -> 405
import { createHash } from 'node:crypto';

export function fakeDav({ root = 'https://dav.test/remote.php/webdav/', user = 'u', token = 'a b c', clock = Date.now } = {}) {
  const files = new Map(); // path -> {body: Uint8Array, etag}
  const dirs = new Set(['']);
  let n = 0;
  const auth = 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64');
  const stats = { requests: 0, puts: 0, p412: 0 };
  const etagOf = (b) => `"${createHash('md5').update(b).update(String(++n)).digest('hex')}"`;

  async function fetchImpl(url, init = {}) {
    stats.requests++;
    const method = (init.method || 'GET').toUpperCase();
    const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (h.authorization !== auth) return new Response('', { status: 401 });
    if (!url.startsWith(root)) return new Response('', { status: 404 });
    const path = decodeURIComponent(url.slice(root.length)).replace(/\/+$/, '');
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const f = files.get(path);
    switch (method) {
      case 'GET':
        if (!f) return new Response('', { status: 404 });
        return new Response(f.body, { status: 200, headers: { etag: f.etag, date: new Date(clock()).toUTCString() } });
      case 'HEAD':
        if (!f) return new Response(null, { status: 404 });
        return new Response(null, { status: 200, headers: { etag: f.etag, 'content-length': String(f.body.length) } });
      case 'PUT': {
        stats.puts++;
        if (!dirs.has(parent)) return new Response('', { status: 409 });
        if (h['if-match'] && (!f || h['if-match'] !== f.etag)) { stats.p412++; return new Response('', { status: 412 }); }
        const body = typeof init.body === 'string' ? new TextEncoder().encode(init.body) : new Uint8Array(init.body);
        const etag = etagOf(body);
        files.set(path, { body, etag });
        return new Response(null, { status: f ? 204 : 201, headers: { etag } });
      }
      case 'MKCOL':
        if (dirs.has(path)) return new Response('', { status: 405 });
        if (!dirs.has(parent)) return new Response('', { status: 409 });
        dirs.add(path);
        return new Response('', { status: 201 });
      case 'DELETE':
        for (const k of [...files.keys()]) if (k === path || k.startsWith(path + '/')) files.delete(k);
        for (const d of [...dirs]) if (d === path || d.startsWith(path + '/')) dirs.delete(d);
        return new Response('', { status: 204 });
      case 'PROPFIND': {
        if (!dirs.has(path) && !files.has(path)) return new Response('', { status: 404 });
        const base = new URL(root).pathname;
        const items = [`<d:response><d:href>${base}${path}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getetag>"dir"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`];
        if (h.depth !== '0') {
          for (const [k, v] of files) {
            if (k.slice(0, k.lastIndexOf('/')) !== path) continue;
            items.push(`<d:response><d:href>${base}${k.split('/').map(encodeURIComponent).join('/')}</d:href><d:propstat><d:prop><d:resourcetype/><d:getetag>${v.etag}</d:getetag><d:getcontentlength>${v.body.length}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
          }
        }
        return new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${items.join('')}</d:multistatus>`, { status: 207 });
      }
      default:
        return new Response('', { status: 405 });
    }
  }
  return { fetch: fetchImpl, files, dirs, stats, root, user, token };
}
