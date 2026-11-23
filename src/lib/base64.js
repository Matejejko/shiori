// Base64 <-> bytes without Buffer (works in service worker, pages and Node).

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHA.length; i++) LOOKUP[ALPHA.charCodeAt(i)] = i;
LOOKUP['-'.charCodeAt(0)] = 62; // tolerate base64url
LOOKUP['_'.charCodeAt(0)] = 63;

/** Strip an optional data: URL prefix; returns the bare base64 payload. */
export function stripDataUrl(s) {
  if (s.startsWith('data:')) {
    const comma = s.indexOf(',');
    return comma === -1 ? '' : s.slice(comma + 1);
  }
  return s;
}

export function b64ToBytes(input) {
  const s = stripDataUrl(input);
  const out = new Uint8Array(Math.ceil(s.length * 3 / 4));
  let n = 0, acc = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 61) break; // '='
    const v = c < 128 ? LOOKUP[c] : -1;
    if (v < 0) {
      if (c === 10 || c === 13 || c === 32 || c === 9) continue; // whitespace
      throw new Error('invalid base64 character at ' + i);
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[n++] = (acc >>> bits) & 0xff; }
  }
  return out.subarray(0, n);
}

export function bytesToB64(bytes) {
  let out = '';
  const len = bytes.length;
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHA[v >>> 18] + ALPHA[(v >>> 12) & 63] + ALPHA[(v >>> 6) & 63] + ALPHA[v & 63];
  }
  if (i < len) {
    const v = (bytes[i] << 16) | ((i + 1 < len ? bytes[i + 1] : 0) << 8);
    out += ALPHA[v >>> 18] + ALPHA[(v >>> 12) & 63];
    out += i + 1 < len ? ALPHA[(v >>> 6) & 63] + '=' : '==';
  }
  return out;
}
