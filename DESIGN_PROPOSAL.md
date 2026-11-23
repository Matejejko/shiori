# Shiori UI redesign: proposal

Look only, no behaviour changes. The before-shots are in `test-results/design/before/` (gitignored), named `<screen>-<light|dark>.png`. They were taken in Playwright Chromium with `test/fixtures/synthetic-export.json` imported.

## Selectors that must survive (from `test/` + runtime code)

**Tests use:**
- Library: `#grid .tile`, `#count`, `#fTag summary`, `#fTag input[value=…]`
- Tabs: `button[data-tab=io|library|settings]`
- Import/Export: `#file`, `#summary`, `#summary .summary`, `#summary button`, `#summary .ok-text`, `#export`
- Settings: `#settings [name=davUrl|user|token]`, `#settings button[type=submit]`, `#test`, `#settingsMsg`
- Popup: `#current`, `#current .title`, `#current form button[type=submit]`

**Text the tests wait for:** `N entries`, `now has N entries`, `Arena Scans series`, `Pinned|Already`, `Connected`, `Saved.`, `Action, Fantasy`.

**Runtime JS also depends on:**
- every id in both HTML files
- `.tab` + `.on`, `.pane` + `[hidden]`, `data-tab`, `data-kind`
- `.labels .card`, `.rows`, `.rows .row`, `.add`, `.opts`, `input[name=mode]`, `dialog#edit`, `.tagpick`
- pill classes `ok|err|pending|busy|off`
- `role="tablist"`/`role="tab"` and every `aria-*`

All of these stay byte-identical.

## Diagnosis (outside-designer view)

1. **The toolbar is 9 controls of equal weight in one ragged row.** (`library-1440-light.png`; `src/app/app.html:25-41`, `app.css:13-14`)
   - Search, 4 filters, a lower-case "unread" checkbox, sort, a 10px `103 / 103` and an *action* ("Check releases") all have the same height and visual weight.
   - At 900px it wraps into two unaligned rows with the count stranded mid-line (`library-900-dark.png`).
   - The tag filter (a `<details>`) has a different height and border from the native selects next to it.
2. **Tiles bury the only thing that matters.** (`library-1440-*.png`; `app.js:105-113`, `app.css:15-21`)
   - The "you have new chapters" signal is a 11px `+5` pill at the very bottom of the card, below three lines of equal 12–13px grey text.
   - Progress is the string `Read 47.5 / –`; there's no visual sense of how far along you are.
   - Missing covers are blank beige slabs with no name, so 8+ tiles in the grid are anonymous.
   - Every tile is the same SaaS card: border, radius, white box.
3. **The editor dialog is a flat 10-field form.** (`editor-light.png`; `app.js:182-222`, `app.css:24-27`)
   - Name, URL, folder, type, tags, "Add tag number", score, progress and two dates all sit in one undifferentiated 2-column grid.
   - The footer puts Save, Check releases, Cancel and **Delete** side by side at the same size, so Delete is one mis-tap from Cancel.
   - There's no max-height: at 900px the dialog nearly overflows the viewport.
4. **The header separates state from action.** (`library-*.png`; `app.html:11-21`, `app.css:2-6`, `base.css:27-28`)
   - The brand is bold body text.
   - Tabs look like ghost buttons, with the active one a boxed button.
   - The sync pill is 12px grey text pushed far right, and "Sync now" floats next to it with no visual relation.
5. **The popup has no "continue reading" focus.** (`popup-reading-dark.png`, `popup-idle-light.png`; `popup.js:128-206`, `popup.css`)
   - On a chapter page the card shows `Read 170 / latest 172` as plain text. The most prominent element is an orange **Set** button, which is a manual *correction*, the rarest action.
   - The unread list (the actual "what next" list) is unstyled rows with no visible sign they open a tab.
   - On a non-manga page a 70px empty card wastes the top of the popup.
6. **Empty, loading and error states are afterthoughts.** (`library-empty-dark.png`; `app.js:115`)
   - Empty library: the message `<p>` becomes a 150px grid cell, so it wraps into a narrow column top-left.
   - Loading: the grid is simply blank until data arrives.
   - Errors are 12px red text with no container.
   - Bug: the Settings → Status `<dl class="summary">` gets no styling because the rule is `.summary dl` (`app.css:31` vs `app.js:323`). It renders as browser-default indented `dt/dd` (`settings-dark.png`).
7. **Generic palette, no type hierarchy.** (`base.css:1-10`, `app.css:10`)
   - Warm cream `#f7f5f2` with a burnt-orange `#c2410c` accent is the most common AI-template look.
   - Orange is used for *every* primary button, the unread badge and focus rings, so nothing stands out.
   - Text is 14px system-ui everywhere, headings 15px, meta 12px.
   - Chapter numbers (the core data) are set in proportional figures inside sentences.
8. **Import/Export, Settings and Labels are raw forms in full-width cards.** (`io-dryrun-light.png`, `labels-light.png`)
   - The dry-run key/value list has a 280px dead column.
   - The Labels page shows three equal cards even though Types has one row.
   - Remove buttons are bare `✕` squares the same size as inputs.

## Aesthetic direction: "Obi"

A manga volume in a shop wears an **obi**: a bright paper band around the cover that announces what's new. Shiori's job is exactly that: say what's new, and say where you stopped (shiori = bookmark).

- **The library becomes a shelf.** Covers sit directly on a cool paper ground with no card boxes: the cover *is* the object.
- **The only loud element is a signal-yellow obi band** across the bottom of a cover when chapters are waiting.
- **Actions use aizome indigo**, the dye of Japanese work cloth: quiet, ink-like, and clearly not the orange template accent.
- **Missing covers get a screentone texture** (halftone dots, the manga printing technique) with the title set in it, instead of a blank slab.
- **Chapter numbers become the typographic hero:** heavy tabular figures, so "how far am I" reads at a glance.

Everything else (forms, settings) stays calm and plain, so the yellow keeps its meaning.

*Checked against the generic defaults:*
- Not cream + terracotta: cool paper + indigo.
- Not near-black + acid green; the dark mode is blue ink, not `#111`.
- No hairline newspaper layout, and no identical card grid (the tiles lose their card).
- No all-caps eyebrows, monospace labels or `→` links. Middle-dot meta strings get split into separate styled spans (J1, P1).

## Tokens

### Colour (contrast = WCAG ratio)
| token | light | dark | role / contrast |
|---|---|---|---|
| `--paper` | `#EEF0F4` | `#151821` | page ground |
| `--sheet` | `#FFFFFF` | `#1D212B` | dialogs, fields, popovers |
| `--ink` | `#171A21` | `#E7E9EF` | text: 15.3 / 17.4 (light, paper/sheet) · 14.6 / 13.3 (dark) |
| `--ink-2` | `#555C6B` | `#A4ABB9` | secondary text: 5.9 / 6.7 · 7.7 / 7.0 |
| `--line` | `#D5D9E1` | `#2C313D` | decorative dividers only (not control boundaries) |
| `--edge` | `#7C8494` | `#6E7688` | control borders: 3.3 / 3.8 · 3.9 / 3.5 (≥3:1) |
| `--ai` (indigo) | `#2C47A3` | `#93A8FF` | primary actions, focus, links: 7.3 / 8.3 · 7.8 / 7.1 |
| `--ai-ink` | `#FFFFFF` | `#121521` | text on indigo: 8.3 · 8.0 |
| `--obi` | `#FFD23F` | `#FFD23F` | unread band; text on it `#171A21`: 12.1 |
| `--ok` | `#1A7542` | `#5FD08F` | 5.0 / 5.7 · 9.2 / 8.4 |
| `--err` | `#B3261E` | `#FF8B82` | 5.7 / 6.5 · 7.8 / 7.1 |
| `--warn` | `#835400` | `#EDBE52` | 5.7 / 6.5 · 10.2 / 9.3 |

**Why the yellow band is allowed below 3:1 in light mode:** its fill against light paper is only 1.3:1, but it never stands alone. It sits on cover art, carries 12:1 ink text, and gets a 1px `--ink` top rule (≥3:1 against any light ground), which is what identifies it.

### Type (system fonts only, no files)
- **Text:** `ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Noto Sans", "Hiragino Sans", "Noto Sans CJK JP", "Apple SD Gothic Neo", sans-serif`. The CJK fallbacks cover Japanese and Korean titles.
- **Numerals:** `font-variant-numeric: tabular-nums` everywhere chapters appear.
- **Scale:** 12 / 13 / 14 (base) / 16 / 20 / 28px, line-height 1.45 for body and 1.15 for numerals.
- **Weights:** 400 body, 600 titles, 760 chapter numerals and the wordmark (variable system fonts support it; others round to 700).
- **Tracking:** −0.01em on 20px+.
- **No bundled font.** One would need your OK to add files. The direction works with system faces because the character comes from the obi band, the screentone and the numerals.

### Spacing, radii, shadows, motion
- **Spacing:** 4-pt scale: 4, 8, 12, 16, 24, 32.
- **Radii, by hierarchy (not one radius everywhere):**
  - covers 3px (books have sharp corners)
  - controls 6px
  - dialog and popover 12px
  - chips 999px
- **Shadows:** only on things that float: dialog and the tag popover, `0 16px 40px rgb(16 19 26 / .22)`; in dark, `0 16px 40px rgb(0 0 0 / .5)`. Tiles get none.
- **Motion:** three moments, all inside `@media (prefers-reduced-motion: no-preference)`:
  - dialog opens with fade + 0.98→1 scale, 140ms
  - tab underline slides, 160ms
  - a tile cover lifts 2px on hover **and** `:focus-visible`, 120ms
- **Focus:** `2px solid var(--ai)`, offset 2px, on every control, tile, summary, link and checkbox. Nothing relies on hover only.

## Per-screen plan

**Header** (`app.html:11-21`, `base.css`, `app.css`)
- Wordmark: 20px/760 "Shiori" with a small CSS bookmark ribbon before it (`.brand::before`; no new file).
- Tabs become text tabs with a 2px indigo underline on `.tab.on`; no boxed button.
- `#sync` and `#syncNow` are wrapped together in `<div class="syncbox">` and read as one segmented control, with the state shown by a coloured dot (`.pill.ok::before` etc.).

**Library toolbar** (`app.html:25-41`, `app.css`): regrouped into three zones.
1. `#q` gets class `search`, full-width on narrow screens, with a search icon via CSS background.
2. `<div class="filters">` holds `#fFolder #fType #fTag #fSite` and the unread label. Text changes from "unread" to "Unread only".
3. `<div class="viewctl">` holds `#sort #count #checkAll`. `#count` becomes 13px tabular; `#checkAll` becomes a ghost button.
- Selects and the tag `summary` share one control height (34px), border and chevron.
- At ≤960px: search on row 1, filters on row 2 (horizontal scroll inside the group if needed), view controls on row 3, aligned right.

**Tiles** (`app.js:105-113` J1, `app.css`)
- No card box. The cover is wrapped in `.spine` (3px radius, a 1px `--line` inner edge, a lift on hover/focus).
- **Obi band** (`.badge.obi`): absolutely placed across the bottom 22% of the cover, yellow, ink text, 16px/760, e.g. `+5`.
- Caption: title 14px/600 (2 lines), then a `.line` with site and folder as separate 12px spans, then a thin `<progress>` bar (indigo on `--line`), then the existing "Read N / M" text at 12px tabular.
- Missing cover: `.art.tone` with a screentone background (CSS radial-gradient dots in `--line`) and the title at 13px/600 inside, `aria-hidden`.
- "check failed" becomes a small err-coloured chip.

**Empty / loading / error** (CSS + J2)
- `#grid:empty::before` shows "Loading library…" in muted 14px, centred. Pure CSS, no JS.
- `.grid > p` spans all columns and is centred at 16px, with screentone behind it. The text stays as is.
- `.err-text` inside `#summary`/`#status` gets a left 3px `--err` rule and padding. CSS only.

**Editor dialog** (`app.js:182-222` J3, `app.css`)
- `dialog` max-height `min(860px, 92vh)` with the body scrolling; header and footer stay fixed.
- **Header** (`.ed-head`): 84px cover, title at 20px, site/slug muted, and "Read 92 · latest 92" with the numbers made prominent by CSS on the existing text. Links as indigo text links.
- **Body:** three `<fieldset>`s with `<legend>` (*Reading*: progress, score, started, finished · *Shelf*: folder, type, tags, add tag number · *Series*: name, URL).
- **Footer** (`.ed-foot`): left side `Delete` (danger outline, not filled) + `Check releases` (ghost) + message; right side `Cancel` (ghost) + `Save` (indigo). Delete moves away from Cancel.

**Import / Export** (CSS only)
- Two columns ≥1100px (import wider), one column below.
- Dry run: `.summary dl` becomes a 2-column stat list with `dt` muted 13px and `dd` 16px tabular, column width `auto 1fr` with a sane max.
- The primary button stays as is (test clicks `#summary button`).
- `input[type=file]` styled with `::file-selector-button` as a ghost button.

**Settings** (CSS only)
- Form max 640px; the Status card next to it ≥1100px.
- Fix `dl.summary` styling (bug in diagnosis 6).
- `#hostAccess` gets a warn-coloured left rule.

**Labels** (J6, CSS)
- Cards size to their content (`align-items: start`), so Types no longer stretches to the height of Tags.
- `input.key` 64px tabular.
- The remove button becomes a 28px square icon button (`ghost icon`).

**Popup** (`popup.html`, `popup.js` P1–P2, `popup.css`)
- Header: wordmark, then the `syncbox` (pill + Sync), then Library.
- **Current page = "continue reading" hero:** 72×102 cover, title 16px/600, site and folder as separate spans, then **big numerals** "170 / 172" via styled existing text plus a `<progress>` bar.
- The manual correction (`Progress [input] Set`) becomes one muted line below with a ghost `Set` button.
- Pin form (unpinned page): the indigo primary `Pin series` button stays the one strong action.
- Idle state: `#current:has(> p:only-child)` collapses to a slim one-line hint with no card padding.
- Unread list: each row is a full-width focusable row with the cover thumb, title, `66 → 67` and a yellow obi chip `+1` on the right.
- The list scrolls inside `max-height`, so body width stays 380px and total height ≤600px.

## JS edits (class/markup only; exact strings)

**J1** `src/app/app.js:105-113` (tile). Before:
```js
url ? h('img', { class: 'art', src: url, attrs: { alt: '', loading: 'lazy' } }) : h('div', { class: 'art' }),
h('div', { class: 'meta' },
  h('span', { class: 'name', text: e.name }),
  h('span', { class: 'muted small', text: `${e.siteId} · ${labelFor('folder', e.folder)}` }),
  h('span', { class: 'small', text: /* unchanged */ }),
  n > 0 ? h('span', { class: 'badge', text: `+${fmtChap(n)}` }) : null,
  err ? h('span', { class: 'small err-text', text: 'check failed', attrs: { title: err.error } }) : null,
```
After:
```js
h('span', { class: 'spine' },
  url ? h('img', { class: 'art', src: url, attrs: { alt: '', loading: 'lazy' } }) : h('span', { class: 'art tone', text: e.name, attrs: { 'aria-hidden': 'true' } }),
  n > 0 ? h('span', { class: 'badge obi', text: `+${fmtChap(n)}` }) : null),
h('span', { class: 'meta' },
  h('span', { class: 'name', text: e.name }),
  h('span', { class: 'line' }, h('span', { class: 'site', text: e.siteId }), h('span', { class: 'folder', text: labelFor('folder', e.folder) })),
  typeof e.progress?.chap === 'number' && typeof e.latest?.chap === 'number' ? h('progress', { attrs: { max: e.latest.chap, value: Math.min(e.progress.chap, e.latest.chap), 'aria-hidden': 'true' } }) : null,
  h('span', { class: 'small read', text: /* unchanged */ }),
  err ? h('span', { class: 'small err-text chip', text: 'check failed', attrs: { title: err.error } }) : null,
```
- `div` becomes `span`, because a `<div>` inside a `<button>` is invalid HTML.
- **Flags for your approval:**
  - the visible text `" · "` disappears (CSS draws the separation instead)
  - the `<progress>` bar uses a guarded value expression (display only; the text stays the accessible source)

**J2** `app.js:115`: `class: 'muted'` becomes `class: 'muted empty'`.

**J3** `app.js:167-222` (editor). The `h()` tree is regrouped; every field element and every handler is untouched.
- **The form:** `class: 'stack'` becomes `class: 'editor'`.
- **The header row:**
  - `h('div', { class: 'row' }, …cover…, h('div', { class: 'grow stack' }, …))` becomes `h('div', { class: 'row ed-head' }, …same…)`.
  - Inside it: the links row `class: 'row tight'` becomes `class: 'row tight ed-links'`.
- **The body:** `h('div', { class: 'form-grid' }, …10 labels…)` becomes:
  ```js
  h('div', { class: 'ed-body' },
    h('fieldset', { class: 'form-grid' }, h('legend', { text: 'Reading' }), <Progress label>, <Score label>, <Started label>, <Finished label>),
    h('fieldset', { class: 'form-grid' }, h('legend', { text: 'Shelf' }), <Folder label>, <Type label>, <Tags div>, <Add tag number label>),
    h('fieldset', { class: 'form-grid' }, h('legend', { text: 'Series' }), <Name label>, <Series URL label>))
  ```
- **The footer:** `h('div', { class: 'row tight' }, Save, Check releases, Cancel, Delete, msg)` becomes:
  ```js
  h('div', { class: 'ed-foot' },
    h('div', { class: 'row tight' }, Delete, Check releases, msg),
    h('div', { class: 'row tight' }, Cancel, Save))
  ```
  - Delete's `class: 'danger'` becomes `class: 'danger quiet'`.
- **Flags for your approval:**
  - the new legend texts "Reading", "Shelf", "Series"
  - the button order changes (Save stays `type: 'submit'`)

**J6** `app.js:377`: the remove button `class: 'ghost'` becomes `class: 'ghost icon'`.

**P1** `src/popup/popup.js:134-155` (current entry):
- Outer `h('div', { class: 'row' }` becomes `h('div', { class: 'row now' }`.
- `h('div', { class: 'muted small', text: `${cur.site || e.siteId} · ${folderName(lib.labels, e.folder)}` })` becomes:
  ```js
  h('div', { class: 'muted small line' }, h('span', { text: cur.site || e.siteId }), h('span', { text: folderName(lib.labels, e.folder) }))
  ```
- `h('div', { class: 'small', text: `Read ${fmtChap(p)} / latest ${fmtChap(l)}` })` becomes the same with `class: 'small read'`, followed by:
  ```js
  typeof p === 'number' && typeof l === 'number' ? h('progress', { attrs: { max: l, value: Math.min(p, l), 'aria-hidden': 'true' } }) : null
  ```
- Form `class: 'row tight'` becomes `class: 'row tight correct'`; `h('button', { type: 'submit', text: 'Set' })` becomes `h('button', { type: 'submit', class: 'ghost', text: 'Set' })`.
- **Flag for your approval:** `" · "` text removed.

**P2** `popup.js:201-203` (unread row):
```js
h('span', { class: 'muted small block', text: `${…} → ${…}${behind > 0 … ? ` (+${fmtChap(behind)})` : ''}` })
```
becomes
```js
h('span', { class: 'muted small block', text: `${fmtChap(e.progress?.chap)} → ${fmtChap(e.latest.chap)}` })
```
plus, after the `grow` span:
```js
behind > 0 && Number.isFinite(behind) ? h('span', { class: 'obi', text: `+${fmtChap(behind)}` }) : null
```
- **Flag for your approval:** "(+N)" moves out of the sentence into a chip.

**HTML text:** "unread" becomes "Unread only" (`app.html:31`). No other copy changes. No test waits on these strings.

## Files touched in Phase 2
- `src/ui/base.css`: tokens, base controls, focus, pill, progress, chips
- `src/app/app.css`: header, toolbar, shelf tiles, dialog, pages
- `src/popup/popup.css`: popup layout
- `src/app/app.html`: syncbox wrapper, toolbar groups, "Unread only"
- `src/popup/popup.html`: syncbox wrapper
- `src/app/app.js`: J1, J2, J3, J6 (class/markup only)
- `src/popup/popup.js`: P1, P2 (class/markup only)

**No new files, no fonts, no id or data-* changes.**

**Not proposed:**
- theme switcher
- new tabs or settings
- skeleton loaders that need JS
- changing the popup's 380px width
