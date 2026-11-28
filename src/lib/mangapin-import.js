// MangaPin -> Shiori: the only place that turns MangaPin's data into Shiori's (Import → MangaPin
// export). Self-contained: Shiori's own code never sees a MangaPin tag number.
import { parseExport, withField, MANGAPIN_TAGS } from './mangapin.js';
import { normalizeTags } from './labels.js';
import { mergeEntry } from './merge.js';

/** One MangaPin entry in Shiori's form: tag numbers become names; everything else is kept as is. */
export function entryFromMangaPin(e) {
  if (!e || !Array.isArray(e.tags) || !e.tags.some((t) => typeof t !== 'string')) return e;
  const names = e.tags.map((t) => (typeof t === 'number' && Number.isFinite(t) ? MANGAPIN_TAGS[t] || `Tag ${t}` : t));
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
