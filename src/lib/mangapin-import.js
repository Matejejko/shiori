// MangaPin -> Shiori. The only place that turns MangaPin's data into Shiori's: an export file
// (Import → MangaPin export), and entries written before format 2, which are MangaPin's shape
// (the one-time upgrade in store.js / sync.js). Self-contained: Shiori's own code never sees a
// MangaPin tag number.
import { parseExport, withField, MANGAPIN_TAGS } from './mangapin.js';
import { normalizeTags } from './labels.js';
import { mergeEntry } from './merge.js';

/**
 * One MangaPin entry in Shiori's form: tag numbers become names; everything else is kept as is.
 * `own` = names the user gave tag numbers in an older Shiori (labels.tag: { '<n>': {name} }); they win.
 */
export function entryFromMangaPin(e, own) {
  if (!e || !Array.isArray(e.tags) || !e.tags.some((t) => typeof t !== 'string')) return e;
  const named = (t) => (own && own[t] && typeof own[t].name === 'string' && own[t].name.trim()) || MANGAPIN_TAGS[t] || `Tag ${t}`;
  const names = e.tags.map((t) => (typeof t === 'number' && Number.isFinite(t) ? named(t) : t));
  return withField(e, 'tags', normalizeTags(names));
}

/**
 * A MangaPin export -> { order, entries, meta, covers, problems } in Shiori's form. Duplicate
 * ids inside the file are merged. MangaPin's `ts` counts as the edit time of every field (it is
 * all MangaPin keeps); progress is a plain read event.
 */
export function readMangaPin(text) {
  const parsed = parseExport(text);
  const order = [], entries = new Map(), meta = new Map();
  for (const { id, obj: raw } of parsed.entries) {
    const obj = entryFromMangaPin(raw);
    const m = { r: typeof obj.ts === 'number' ? obj.ts : 0 };
    if (entries.has(id)) {
      const r = mergeEntry(entries.get(id), meta.get(id), obj, m);
      entries.set(id, r.entry); meta.set(id, r.meta);
    } else {
      entries.set(id, obj); meta.set(id, m); order.push(id);
    }
  }
  return { order, entries, meta, covers: parsed.imgs, problems: parsed.problems };
}
