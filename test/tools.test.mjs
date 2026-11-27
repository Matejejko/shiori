// tools/shiori-to-mangapin.html: the conversion block, run on every fixture through a full
// MangaPin -> Shiori -> backup -> MangaPin round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportFixtures, mangapinContent } from './helpers.mjs';
import { planImport, exportBackup, emptyLibrary } from '../src/lib/library.js';
import { toDoc } from '../src/lib/sync.js';
import { parseExport } from '../src/lib/mangapin.js';

const html = readFileSync(join(import.meta.dirname, '..', 'tools', 'shiori-to-mangapin.html'), 'utf8');
const block = html.slice(html.indexOf('// <convert>'), html.indexOf('// </convert>'));
const toMangaPin = new Function(`${block}; return toMangaPin;`)();

for (const fx of exportFixtures()) {
  test(`[${fx.name}] MangaPin -> Shiori backup -> MangaPin keeps every entry byte for byte and every cover`, () => {
    const plan = planImport(emptyLibrary(), new Set(), fx.text, 'replace', 1000, 'mangapin');
    const backup = exportBackup(plan.lib, (k) => plan.covers.get(k));
    const out = toMangaPin(backup);
    assert.equal(mangapinContent(out.text), mangapinContent(fx.text));
    // tag names go back to MangaPin's numbers: the entries are byte for byte the original ones
    assert.equal(JSON.stringify(JSON.parse(out.text).entries), JSON.stringify(JSON.parse(fx.text).entries.filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i)));
    assert.equal(out.droppedTags, 0);
    assert.equal(out.entries, parseExport(fx.text).entries.length);
    // and MangaPin's own shape: version 1, entries, imgs — which Shiori reads back as MangaPin
    assert.deepEqual(Object.keys(JSON.parse(out.text)), ['version', 'entries', 'imgs']);
    assert.equal(planImport(emptyLibrary(), new Set(), out.text, 'replace', 1000, 'mangapin').lib.entries.size, plan.lib.entries.size);
  });
}

test('the converter carries the same MangaPin tag table as Shiori; tags MangaPin lacks are left out and counted', async () => {
  const { MANGAPIN_TAGS } = await import('../src/lib/mangapin.js');
  const copy = new Function(`${block}; return MANGAPIN_TAGS;`)();
  assert.deepEqual(copy, MANGAPIN_TAGS);
  const b = JSON.parse(exportBackup(emptyLibrary(), () => undefined));
  b.library.entries = [{ siteId: 's', slug: 'x', name: 'n', folder: 1, tags: ['Action', 'Tower Climbing', 'Tag 999', 'Science Fiction'], ts: 1, id: 'AAAAAAAAAA' }];
  const out = toMangaPin(JSON.stringify(b));
  assert.deepEqual(JSON.parse(out.text).entries[0].tags, [60, 999, 124]);
  assert.equal(out.droppedTags, 1);
});

test('a server snapshot converts too (covers reported missing), other files are refused', () => {
  const fx = exportFixtures()[0];
  const plan = planImport(emptyLibrary(), new Set(), fx.text, 'replace', 1000, 'mangapin');
  const out = toMangaPin(toDoc(plan.lib));
  assert.equal(out.entries, plan.lib.entries.size);
  assert.equal(out.covers, 0);
  assert.ok(out.missingCovers > 0);
  assert.throws(() => toMangaPin(fx.text), /not a Shiori backup/);
  assert.throws(() => toMangaPin('nope'), /not JSON/);
  const b = JSON.parse(exportBackup(plan.lib, () => undefined));
  assert.throws(() => toMangaPin(JSON.stringify({ ...b, version: 9 })), /newer Shiori/);
});
