// Folders and content types are numbers (folder names can be changed in Settings → Labels,
// synced; types are fixed). Tags are names — the genre as the site calls it — in one cleaned-up
// spelling (normalizeTag). Nothing here knows MangaPin's tag numbers: mangapin-import.js does.
import { MANGAPIN_TAGS, MANGAPIN_TAG_VARIANTS } from './mangapin.js';

export const DEFAULT_LABELS = {
  folder: { 1: 'Reading', 2: 'Hiatus', 3: 'Planned', 4: 'Completed', 5: 'Dropped' },
  type: { 1: 'Comic', 2: 'Novel', 3: 'Anime' }, // no type = comic
};

/** The usual spelling of common genres (MangaPin's list), offered in the editor. */
export const KNOWN_TAGS = [...new Set(Object.values(MANGAPIN_TAGS))];

// MangaPin also folded related genres together (regression → Reincarnation, love → Romance);
// Shiori keeps those as their own tags, so these are not treated as other spellings.
const NOT_VARIANTS = new Set(['regression', 'rebirth', 'reincarnate', 'return', 'returned', 'returner', 'love', 'funny', 'cheat system', 'pornographic', 'apocalypse', 'shounen ai', 'shoujo ai', 'niños', 'süper güçler']);

/** Comparison key: case, accents, spaces and punctuation don't make a different tag. */
export const tagKey = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]/gu, '');

let canon = null;
function canonical() {
  if (canon) return canon;
  canon = new Map();
  for (const n of KNOWN_TAGS) if (!canon.has(tagKey(n))) canon.set(tagKey(n), n); // "Cross Dressing" = "Crossdressing"
  for (const [id, list] of Object.entries(MANGAPIN_TAG_VARIANTS)) {
    for (const a of list) if (!NOT_VARIANTS.has(a.toLowerCase())) canon.set(tagKey(a), MANGAPIN_TAGS[id]);
  }
  canon.set(tagKey('Sci-Fi'), 'Science Fiction');
  return canon;
}

const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
const titleCase = (t) => t.toLowerCase().replace(/[\p{L}\p{N}][^\s-]*/gu, (w, i) => (i > 0 && SMALL.has(w) ? w : w[0].toUpperCase() + w.slice(1)));

/** A tag name in its stored spelling, or null if it isn't a usable name. */
export function normalizeTag(v) {
  if (typeof v !== 'string') return null;
  let t = v.replace(/\s+/g, ' ').trim().slice(0, 40).trim();
  if (!/\p{L}/u.test(t)) return null;
  const known = canonical().get(tagKey(t));
  if (known) return known;
  if (t === t.toLowerCase() || t === t.toUpperCase()) t = titleCase(t);
  return t;
}

/** A list of tag names in stored form: one spelling per tag, first one wins, order kept. */
export function normalizeTags(list) {
  const out = [], seen = new Set();
  for (const v of Array.isArray(list) ? list : []) {
    const t = normalizeTag(v);
    if (t && !seen.has(tagKey(t))) { seen.add(tagKey(t)); out.push(t); }
  }
  return out;
}
