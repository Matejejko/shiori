// Cover image -> ~240px wide WebP, keyed like MangaPin: local:<bytes>:<md5>.webp
// Needs createImageBitmap + OffscreenCanvas (Chrome service worker, Firefox event page).

import { coverKeyFor } from './mangapin.js';
import { bytesToB64 } from './base64.js';

export const COVER_WIDTH = 240;
const MAX_HEIGHT = 480; // very tall banners get cropped to a sane aspect

/** @param {Blob} blob source image  @returns {Promise<{key:string, b64:string, bytes:number}>} */
export async function makeCover(blob, width = COVER_WIDTH) {
  const bmp = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, width / bmp.width);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const fullH = Math.max(1, Math.round(bmp.height * scale));
    const h = Math.min(fullH, MAX_HEIGHT);
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, w, fullH);
    const out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
    if (out.type !== 'image/webp') throw new Error('this browser cannot encode WebP');
    const bytes = new Uint8Array(await out.arrayBuffer());
    return { key: coverKeyFor(bytes), b64: bytesToB64(bytes), bytes: bytes.length };
  } finally {
    bmp.close && bmp.close();
  }
}

/** Fetch an image URL (background worker: host permissions bypass CORS). */
export async function fetchImage(url, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('cover URL must be http(s)');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(u.href, { credentials: 'omit', signal: ctrl.signal });
    if (!res.ok) throw new Error(`cover fetch failed: HTTP ${res.status}`);
    const blob = await res.blob();
    if (blob.size > 15 * 1024 * 1024) throw new Error('cover image too large');
    return blob;
  } finally {
    clearTimeout(t);
  }
}
