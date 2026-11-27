import { api, h, clear, send, fmtChap, ago, coverUrl, syncSummary, labelName, folderName, safeHttpUrl } from '../ui/dom.js';
import { formPatch } from '../lib/library.js';
import { DEFAULT_LABELS, KNOWN_TAGS, tagKey } from '../lib/labels.js';
import { computeStats, computeReading, MIN_PER_CHAPTER } from '../lib/stats.js';

const $ = (id) => document.getElementById(id);
const state = { lib: null, covers: {}, st: null, folder: '' };

// ---------------------------------------------------------------------------------------
// tabs

const SETTINGS_PAGES = ['stats', 'settings', 'io', 'labels'];
/** name: 'library' (folder tabs) or a settings page; folder: '' = all, else the folder number */
function showTab(name, folder) {
  if (!SETTINGS_PAGES.includes(name)) name = 'library';
  if (name === 'library' && folder !== undefined) state.folder = String(folder);
  const inSettings = name !== 'library';
  document.body.classList.toggle('in-settings', inSettings);
  $('openSettings').classList.toggle('on', inSettings);
  $('openSettings').setAttribute('aria-pressed', String(inSettings));
  for (const b of document.querySelectorAll('.tab')) {
    const on = b.dataset.tab === name && (name !== 'library' || (b.dataset.folder ?? '') === state.folder);
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  }
  for (const p of document.querySelectorAll('.pane')) p.hidden = p.id !== 'tab-' + name;
  try { localStorage.setItem('shiori.tab', name); localStorage.setItem('shiori.folder', state.folder); } catch { /* ignore */ }
  if (name === 'library' && state.lib) renderGrid();
  if (name === 'settings') renderSettings();
  if (name === 'labels') renderLabels();
  if (name === 'stats') renderStats();
}
$('folderTabs').addEventListener('click', (ev) => { const b = ev.target.closest('.tab'); if (b) showTab('library', b.dataset.folder); });
for (const b of $('settingsNav').querySelectorAll('.tab')) b.addEventListener('click', () => showTab(b.dataset.tab));
// ☰ menu (a popover: closes on outside click / Escape by itself)
for (const b of $('menu').querySelectorAll('button')) b.addEventListener('click', () => { $('menu').hidePopover(); showTab(b.dataset.tab); });

/** One tab per folder (defaults + named + used), each with its series count. */
function renderFolderTabs() {
  const nav = $('folderTabs');
  const count = (f) => state.lib.entries.filter((e) => f === '' || String(e.folder) === f).length;
  const tab = (f, name) => h('button', { type: 'button', role: 'tab', class: 'tab', dataset: { tab: 'library', folder: f } },
    name, h('span', { class: 'count', text: String(count(f)) }));
  clear(nav).append(tab('', 'All'), ...knownKeys('folder').map((f) => tab(String(f), labelFor('folder', f))));
  if (!document.body.classList.contains('in-settings')) showTab('library', state.folder);
}

// ---------------------------------------------------------------------------------------
// data

async function load() {
  const [st, lib] = await Promise.all([send('state'), send('library')]);
  state.st = st; state.lib = lib;
  const keys = [...new Set(lib.entries.map((e) => e.img).filter((k) => k && !(k in state.covers)))];
  if (keys.length) Object.assign(state.covers, await send('covers', { keys }));
  renderSyncPill();
  renderFilters();
  renderFolderTabs();
  renderGrid();
}

function renderSyncPill() {
  const s = syncSummary(state.st.sync, state.st.cfg, state.st.hasToken);
  $('sync').className = 'pill ' + s.cls;
  $('sync').textContent = s.cls === 'err' ? 'Sync error' : s.text;
  $('sync').title = s.text;
}

const distinct = (arr) => [...new Set(arr)].sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))));
function knownKeys(kind, withDefaults = false) {
  if (kind === 'tag') { // names; withDefaults adds the common genres so they can be picked
    const byKey = new Map();
    for (const t of [...state.lib.entries.flatMap((e) => (Array.isArray(e.tags) ? e.tags : [])), ...(withDefaults ? KNOWN_TAGS : [])]) {
      if (typeof t === 'string' && !byKey.has(tagKey(t))) byKey.set(tagKey(t), t);
    }
    return [...byKey.values()].sort((a, b) => a.localeCompare(b));
  }
  const fromEntries = state.lib.entries.flatMap((e) => (kind === 'tag' ? (Array.isArray(e.tags) ? e.tags : []) : e[kind] !== undefined ? [e[kind]] : []));
  const fromLabels = Object.entries(kind === 'folder' ? state.lib.labels?.folder || {} : {}).filter(([, v]) => v && v.name).map(([k]) => Number(k));
  const base = kind === 'folder' || withDefaults ? Object.keys(DEFAULT_LABELS[kind]).map(Number) : [];
  return distinct([...base, ...fromEntries, ...fromLabels].filter((x) => typeof x === 'number' && Number.isFinite(x)));
}
const labelFor = (kind, v) => (kind === 'tag' ? String(v) : labelName(state.lib.labels, kind, v) || (kind === 'folder' ? `Folder ${v}` : `Type ${v}`));

const pickedTags = (el) => [...el.querySelectorAll('input:checked')].map((i) => i.value);
// tag pickers behave like the selects next to them: a click elsewhere or Escape closes them
document.addEventListener('click', (ev) => {
  for (const d of document.querySelectorAll('details.tagpick[open]')) if (!d.contains(ev.target)) d.open = false;
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  for (const d of document.querySelectorAll('details.tagpick[open]')) {
    d.open = false; d.querySelector('summary').focus();
    ev.preventDefault(); // close the picker, not the series window around it
  }
});
/** Checkbox list of tags inside a <details> (sorted by name); fires 'input' on change. */
function fillTagPicker(el, keys, selected, empty) {
  const opts = el.querySelector('.opts');
  const byName = [...keys].sort((a, b) => labelFor('tag', a).localeCompare(labelFor('tag', b)));
  clear(opts).append(...byName.map((v) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', value: v, checked: selected.has(v) }), labelFor('tag', v))));
  const summary = () => {
    const p = pickedTags(el);
    el.querySelector('summary').textContent = p.length ? p.map((v) => labelFor('tag', v)).join(', ') : empty;
  };
  opts.onchange = () => { summary(); el.dispatchEvent(new Event('input')); };
  summary();
}

function fillSelect(sel, all, items) {
  const cur = sel.value;
  clear(sel).append(h('option', { value: '', text: all }), ...items.map(([v, t]) => h('option', { value: v, text: t })));
  sel.value = items.some(([v]) => String(v) === cur) ? cur : '';
}
function renderFilters() {
  fillSelect($('fType'), 'Any type', knownKeys('type').map((f) => [f, labelFor('type', f)]));
  // only worth showing when the library mixes comics with novels/anime (no type = comic)
  $('fType').hidden = new Set(state.lib.entries.map((e) => e.type ?? 1)).size < 2;
  fillTagPicker($('fTag'), knownKeys('tag'), new Set(pickedTags($('fTag'))), 'Any tag');
  fillSelect($('fSite'), 'All sites', distinct(state.lib.entries.map((e) => e.siteId)).map((s) => [s, s]));
}

const unreadBy = (e) => (typeof e.latest?.chap === 'number' && typeof e.progress?.chap === 'number' ? Math.max(0, e.latest.chap - e.progress.chap) : 0);

function renderGrid() {
  const q = $('q').value.trim().toLowerCase();
  const f = { folder: state.folder, type: $('fType').value, tags: pickedTags($('fTag')), site: $('fSite').value, unread: $('fUnread').checked };
  let list = state.lib.entries.filter((e) => {
    if (q && !(`${e.name} ${e.siteId} ${e.slug}`.toLowerCase().includes(q))) return false;
    if (f.folder && String(e.folder) !== f.folder) return false;
    if (f.type && String(e.type ?? 1) !== f.type) return false;
    if (f.tags.length && !f.tags.every((t) => Array.isArray(e.tags) && e.tags.includes(t))) return false; // all ticked tags
    if (f.site && e.siteId !== f.site) return false;
    if (f.unread && !(unreadBy(e) > 0)) return false;
    return true;
  });
  const sort = $('sort').value;
  const by = {
    updated: (a, b) => (b.ts || 0) - (a.ts || 0),
    name: (a, b) => String(a.name).localeCompare(String(b.name)),
    unread: (a, b) => unreadBy(b) - unreadBy(a),
    created: (a, b) => (b.createTs || 0) - (a.createTs || 0),
    release: (a, b) => (b.latest?.ts || 0) - (a.latest?.ts || 0),
  }[sort];
  list = [...list].sort(by);
  $('count').textContent = `${list.length} / ${state.lib.entries.length}`;
  const grid = clear($('grid'));
  for (const e of list) {
    const url = e.img && state.covers[e.img] ? coverUrl(e.img, state.covers[e.img]) : null;
    const n = unreadBy(e);
    const err = state.lib.relerr?.[e.id];
    grid.append(h('button', { type: 'button', class: 'tile', on: { click: () => openEditor(e.id) }, attrs: { title: e.name } },
      h('span', { class: 'spine' },
        url ? h('img', { class: 'art', src: url, attrs: { alt: '', loading: 'lazy' } }) : h('span', { class: 'art tone', text: e.name, attrs: { 'aria-hidden': 'true' } }),
        n > 0 ? h('span', { class: 'badge new', text: `+${fmtChap(n)}` }) : null),
      h('span', { class: 'meta' },
        h('span', { class: 'name', text: e.name }),
        h('span', { class: 'line' }, h('span', { class: 'site', text: e.siteId }), h('span', { class: 'folder', text: labelFor('folder', e.folder) })),
        typeof e.progress?.chap === 'number' && typeof e.latest?.chap === 'number' ? h('progress', { attrs: { max: e.latest.chap, value: Math.min(e.progress.chap, e.latest.chap), 'aria-hidden': 'true' } }) : null,
        h('span', { class: 'small read', text: typeof e.progress?.chap === 'number' ? `Read ${fmtChap(e.progress.chap)} / ${fmtChap(e.latest?.chap)}` : `Not started${typeof e.latest?.chap === 'number' ? ` · ${fmtChap(e.latest.chap)} ch` : ''}` }),
        err ? h('span', { class: 'small err-text chip', text: 'check failed', attrs: { title: err.error } }) : null,
      )));
  }
  if (!list.length) grid.append(h('p', { class: 'muted empty', text: state.lib.entries.length ? 'No series match the filters.' : 'Library is empty — import a backup or MangaPin export, or pin a series from the popup.' }));
}

for (const id of ['q', 'fType', 'fTag', 'fSite', 'fUnread', 'sort']) $(id).addEventListener('input', renderGrid);
$('checkAll').addEventListener('click', async () => {
  $('checkAll').disabled = true; $('checkAll').textContent = 'Checking…';
  try {
    const r = await send('checkReleases', { force: true });
    $('checkAll').textContent = r.skipped ? 'Disabled' : `Checked ${r.checked}, ${r.changed} new, ${r.errors.length} failed`;
  } catch (e) { $('checkAll').textContent = e.message; }
  setTimeout(() => { $('checkAll').textContent = 'Check releases'; $('checkAll').disabled = false; }, 4000);
  load();
});

// ---------------------------------------------------------------------------------------
// editor

function numOrEmpty(v) { return v === undefined || v === null ? '' : String(v); }
const toDateInput = (ts) => (ts ? new Date(ts - new Date(ts).getTimezoneOffset() * 60000).toISOString().slice(0, 10) : '');
const fromDateInput = (s) => (s ? new Date(s + 'T12:00:00').getTime() : undefined);

// click on the backdrop (outside the window) closes the series dialog and the confirmation
for (const id of ['edit', 'confirm']) $(id).addEventListener('click', (ev) => { if (ev.target === ev.currentTarget) ev.currentTarget.close(); });

/** Styled confirmation in the middle of the screen; resolves true only on the confirm button. */
function confirmBox(title, body, okText) {
  const d = $('confirm');
  d.querySelector('.c-title').textContent = title;
  d.querySelector('.c-body').textContent = body;
  d.querySelector('.c-ok').textContent = okText;
  d.returnValue = '';
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true }));
}

function openEditor(id) {
  const e = state.lib.entries.find((x) => x.id === id);
  if (!e) return;
  const dlg = clear($('edit'));
  const urls = state.lib.urls[id] || {};
  const f = {
    name: h('input', { type: 'text', value: e.name || '' }),
    url: h('input', { type: 'url', value: e.url || '', placeholder: urls.series || 'https://…' }),
    folder: h('select', {}, knownKeys('folder').map((v) => h('option', { value: v, text: labelFor('folder', v), selected: v === e.folder }))),
    type: h('select', {}, h('option', { value: '', text: '(none)' }), knownKeys('type').map((v) => h('option', { value: v, text: labelFor('type', v), selected: v === e.type }))),
    tags: h('details', { class: 'tagpick' }, h('summary'), h('div', { class: 'opts' })),
    newTag: h('input', { type: 'text', placeholder: 'e.g. Tower Climbing', attrs: { maxlength: 40 } }),
    score: h('input', { type: 'number', step: 'any', value: numOrEmpty(e.score) }),
    startTs: h('input', { type: 'date', value: toDateInput(e.startTs) }),
    endTs: h('input', { type: 'date', value: toDateInput(e.endTs) }),
    progress: h('input', { type: 'number', step: 'any', min: 0, value: numOrEmpty(e.progress?.chap) }),
    moveUrl: h('input', { type: 'url', placeholder: 'https://new-site/series/…', attrs: { 'aria-label': 'Address of the series on the new site' } }),
  };
  fillTagPicker(f.tags, knownKeys('tag', true), new Set(Array.isArray(e.tags) ? e.tags : []), '(no tags)');
  // values as shown; Save sends only what differs from this snapshot (see formPatch)
  const readForm = () => ({
    name: f.name.value.trim(), url: f.url.value.trim() || undefined, folder: Number(f.folder.value),
    type: f.type.value === '' ? undefined : Number(f.type.value),
    tags: pickedTags(f.tags).concat(f.newTag.value.trim() ? [f.newTag.value.trim()] : []),
    score: f.score.value === '' ? undefined : Number(f.score.value),
    startTs: f.startTs.value === toDateInput(e.startTs) ? e.startTs : fromDateInput(f.startTs.value),
    endTs: f.endTs.value === toDateInput(e.endTs) ? e.endTs : fromDateInput(f.endTs.value),
  });
  const init = { ...readForm(), progress: f.progress.value };
  const msg = h('span', { class: 'small' });
  const seriesLink = safeHttpUrl(e.url || urls.series);
  const nextLink = safeHttpUrl(urls.next);
  dlg.append(h('form', { class: 'editor', attrs: { method: 'dialog' }, on: { submit: async (ev) => {
    ev.preventDefault();
    try {
      if (f.url.value.trim() && !safeHttpUrl(f.url.value.trim())) throw new Error('URL must start with http(s)://');
      const cur = readForm();
      if (cur.name === '') cur.name = init.name; // an empty name is not a rename
      const patch = formPatch(e, init, cur);
      if (Object.keys(patch).length) await send('edit', { id, patch });
      const pc = f.progress.value.trim() === '' ? null : Number(f.progress.value);
      if (pc !== null && (!Number.isFinite(pc) || pc < 0)) throw new Error('Progress must be a chapter number');
      if (pc !== null && f.progress.value !== init.progress) await send('setProgress', { id, chap: pc, manual: true });
      dlg.close();
      await load();
    } catch (err) { msg.textContent = err.message; msg.className = 'small err-text'; }
  } } },
    // details view (default) — "Edit details" switches the same dialog into the form
    h('div', { class: 'ed-head' },
      h('span', { class: 'ed-cover' },
        e.img && state.covers[e.img] ? h('img', { class: 'cover', src: coverUrl(e.img, state.covers[e.img]), attrs: { alt: '' } }) : h('span', { class: 'cover tone' }),
        unreadBy(e) > 0 ? h('span', { class: 'badge new', text: `+${fmtChap(unreadBy(e))}` }) : null),
      h('div', { class: 'ed-info' },
        h('h2', { class: 'ed-title', text: e.name }),
        h('div', { class: 'line' },
          h('span', { class: 'chip site', text: e.siteId }),
          h('span', { class: 'chip', text: labelFor('folder', e.folder) }),
          e.type !== undefined ? h('span', { class: 'chip', text: labelFor('type', e.type) }) : null),
        h('div', { class: 'ed-progress' },
          typeof e.progress?.chap === 'number'
            ? h('span', { class: 'stat' }, h('span', { class: 'num big', text: fmtChap(e.progress.chap) }), typeof e.latest?.chap === 'number' ? h('span', { class: 'of', text: `of ${fmtChap(e.latest.chap)}` }) : null)
            : h('span', { class: 'stat' }, h('span', { class: 'num big quiet', text: 'Not started' })),
          typeof e.progress?.chap === 'number' && typeof e.latest?.chap === 'number' ? h('progress', { attrs: { max: e.latest.chap, value: Math.min(e.progress.chap, e.latest.chap), 'aria-hidden': 'true' } }) : null,
          h('span', { class: 'muted small', text: typeof e.latest?.chap === 'number'
            ? `Latest chapter ${fmtChap(e.latest.chap)}${e.latest.ts ? `, found ${ago(e.latest.ts)}` : ''}`
            : 'No chapters found yet. Check releases looks them up.' })),
        h('div', { class: 'row tight ed-links' },
          nextLink ? h('a', { class: 'btn', href: nextLink, text: `Continue: ch ${fmtChap(e.next?.chap)}`, target: '_blank', rel: 'noopener noreferrer' }) : null,
          seriesLink ? h('a', { class: nextLink ? 'btn ghost' : 'btn', href: seriesLink, text: 'Open series', target: '_blank', rel: 'noopener noreferrer' }) : null),
      )),
    h('div', { class: 'ed-view' },
      Array.isArray(e.tags) && e.tags.length ? h('div', { class: 'tags' }, e.tags.map((t) => h('span', { class: 'chip', text: labelFor('tag', t) }))) : h('p', { class: 'muted small', text: 'No tags yet.' }),
      h('dl', { class: 'facts' },
        h('dt', { text: 'Score' }), h('dd', { text: e.score ?? '–' }),
        h('dt', { text: 'Started' }), h('dd', { text: e.startTs ? new Date(e.startTs).toLocaleDateString() : '–' }),
        h('dt', { text: 'Finished' }), h('dd', { text: e.endTs ? new Date(e.endTs).toLocaleDateString() : '–' }),
        h('dt', { text: 'Source' }), h('dd', { class: 'muted', text: `${e.siteId} / ${e.slug}` }))),
    h('div', { class: 'ed-body' },
      h('fieldset', { class: 'form-grid' }, h('legend', { text: 'Reading' }),
        h('label', {}, 'Progress (chapter)', f.progress),
        h('label', {}, 'Score', f.score),
        h('label', {}, 'Started', f.startTs),
        h('label', {}, 'Finished', f.endTs)),
      h('fieldset', { class: 'form-grid' }, h('legend', { text: 'Shelf' }),
        h('label', {}, 'Folder', f.folder),
        h('label', {}, 'Type', f.type),
        h('div', { class: 'full' }, h('div', { class: 'lbl', text: 'Tags' }), f.tags),
        h('label', {}, 'Add a tag', f.newTag)),
      h('fieldset', { class: 'form-grid' }, h('legend', { text: 'Series' }),
        h('label', { class: 'full' }, 'Name', f.name),
        h('label', { class: 'full' }, 'Series URL (optional; rebuilt from site + slug when empty)', f.url)),
      h('fieldset', { class: 'form-grid' }, h('legend', { text: 'Move to another site' }),
        h('p', { class: 'muted small full', text: 'Site gone or moved? Paste this series’ address on the new site. Progress, folder, tags, score, dates and cover stay; the old site’s chapter list is dropped and the new one is checked.' }),
        h('div', { class: 'full row tight' }, f.moveUrl, h('button', { type: 'button', class: 'ghost', text: 'Move', on: { click: async () => {
          try {
            const r = await send('move', { id, url: f.moveUrl.value });
            dlg.close();
            await load();
            openEditor(r.id);
          } catch (err) { msg.textContent = err.message; msg.className = 'small err-text'; }
        } } })))),
    h('div', { class: 'ed-foot' },
      h('div', { class: 'row tight' },
        h('button', { type: 'button', class: 'danger quiet edit-only', text: 'Delete', on: { click: async () => {
        if (!(await confirmBox(`Delete “${e.name}”?`, 'It is removed from this library and from your other synced devices.', 'Delete'))) return;
        await send('remove', { id });
        dlg.close();
        await load();
      } } }),
        h('button', { type: 'button', class: 'ghost view-only', text: 'Check releases', on: { click: async () => {
        msg.textContent = 'Checking…';
        try {
          const r = await send('checkReleases', { ids: [id], force: true });
          msg.textContent = r.errors.length ? 'Failed: ' + r.errors[0].error : r.changed ? 'Updated.' : 'No new chapters.';
          await load();
        } catch (err) { msg.textContent = err.message; }
      } } }),
        msg),
      h('div', { class: 'row tight' },
        h('button', { type: 'button', class: 'ghost', text: 'Close', on: { click: () => dlg.close() } }),
        h('button', { type: 'button', class: 'edit-toggle view-only', text: 'Edit details', on: { click: () => { dlg.classList.add('editing'); f.progress.focus(); } } }),
        h('button', { type: 'submit', class: 'edit-only', text: 'Save' }))),
  ));
  dlg.classList.remove('editing'); // always open on the details view
  dlg.showModal();
}

// ---------------------------------------------------------------------------------------
// stats

const fmtInt = (n) => Math.round(n).toLocaleString();
function statTile(value, label, sub, cls = '') {
  return h('div', { class: 'stat-tile ' + cls }, h('div', { class: 'v', text: value }), h('div', { class: 'l', text: label }), sub ? h('div', { class: 'sub', text: sub }) : null);
}
const fmtWeek = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** Chapters per week: one hue, thin columns from a shared baseline, value on the current week, tooltip per column, table view. */
function weekChart(perWeek) {
  const max = Math.max(1, ...perWeek.map((w) => w.chapters));
  const tip = h('div', { class: 'wk-tip', attrs: { role: 'tooltip', hidden: true } });
  const show = (col, w) => {
    tip.textContent = `Week of ${fmtWeek(w.start)}: ${fmtInt(w.chapters)} chapters`;
    tip.hidden = false;
    tip.style.left = `${col.offsetLeft + col.offsetWidth / 2}px`;
  };
  const cols = perWeek.map((w, i) => {
    const last = i === perWeek.length - 1;
    const bar = h('span', { class: 'wk-bar' });
    bar.style.height = `${w.chapters ? Math.max(2, (w.chapters / max) * 100) : 0}%`;
    const col = h('div', { class: 'wk-col' + (last ? ' now' : ''), attrs: { tabindex: 0, 'aria-label': `Week of ${fmtWeek(w.start)}: ${w.chapters} chapters` } },
      last && w.chapters ? h('span', { class: 'wk-val', text: fmtInt(w.chapters) }) : null, bar);
    for (const ev of ['mouseenter', 'focus']) col.addEventListener(ev, () => show(col, w));
    for (const ev of ['mouseleave', 'blur']) col.addEventListener(ev, () => { tip.hidden = true; });
    return col;
  });
  return h('figure', { class: 'wk' },
    h('figcaption', { class: 'muted small', text: 'Chapters per week, last 12 weeks' }),
    h('div', { class: 'wk-plot' }, h('span', { class: 'wk-max muted', text: fmtInt(max) }), ...cols, tip),
    h('div', { class: 'wk-axis muted' }, perWeek.map((w, i) => h('span', { text: i % 4 === 0 || i === perWeek.length - 1 ? fmtWeek(w.start) : '' }))),
    h('details', { class: 'wk-table' }, h('summary', { class: 'muted small', text: 'Show as table' }),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'Week of' }), h('th', { text: 'Chapters' }))),
        h('tbody', {}, [...perWeek].reverse().map((w) => h('tr', {}, h('td', { text: fmtWeek(w.start) }), h('td', { text: fmtInt(w.chapters) })))))));
}

async function renderStats() {
  if (!state.lib) return;
  const s = computeStats(state.lib.entries, state.lib.seen || {});
  const r = computeReading(state.lib.days);
  const box = clear($('stats'));
  box.append(
    h('section', { class: 'stat-group' }, h('h2', { text: 'Reading log' }),
      h('div', { class: 'stat-grid five' },
        statTile(fmtInt(r.today), 'Today', `≈ ${fmtInt(r.today * MIN_PER_CHAPTER)} min`),
        statTile(fmtInt(r.week), 'Last 7 days', `≈ ${fmtInt((r.week * MIN_PER_CHAPTER) / 60)} h`),
        statTile(fmtInt(r.month), 'This month'),
        statTile(fmtInt(r.year), 'This year'),
        statTile(`${r.streak} d`, 'Reading streak', `longest ${r.longest} d`)),
      weekChart(r.perWeek),
      h('p', { class: 'muted small', text: r.since ? `Counting chapters you read on any synced device since ${new Date(r.since).toLocaleDateString()}.` : 'Counts start with the next chapter you read, on any synced device.' })),
    h('section', { class: 'stat-group' }, h('h2', { text: 'Reading' }),
      h('div', { class: 'stat-grid' },
        statTile(fmtInt(s.chapters), 'Chapters read', 'in pinned series', 'hero'),
        statTile(fmtInt(s.chaptersAll), 'Chapters incl. unpinned', s.unpinnedSeries ? `+ ${s.unpinnedSeries} series read but not pinned (30 days)` : 'nothing read unpinned in the last 30 days', 'hero'),
        statTile(`≈ ${fmtInt(s.hours)} h`, 'Time reading', `estimate: ${MIN_PER_CHAPTER} min per chapter`, 'hero'),
        statTile(String(s.activeWeek), 'Series read this week'),
        statTile(fmtChap(s.waiting), 'Chapters waiting', `in ${s.withNew} series with new chapters`),
        statTile(s.longest ? fmtChap(s.longest.chap) : '–', 'Longest read', s.longest ? s.longest.name : ''))),
    h('section', { class: 'stat-group' }, h('h2', { text: 'Library' }),
      h('div', { class: 'stat-grid' },
        statTile(String(s.series), 'In library'),
        ...knownKeys('folder').map((f) => statTile(String(s.folders.get(f) || 0), labelFor('folder', f))),
        statTile(String(s.notStarted), 'Not started'),
        statTile(String(s.added30), 'Added in 30 days'),
        statTile(String(s.finishedYear), 'Finished this year'),
        statTile(s.avgScore === null ? '–' : (Math.round(s.avgScore * 10) / 10).toString(), 'Average score', s.scored ? `${s.scored} scored` : 'nothing scored yet'))),
    h('div', { class: 'stat-cols' },
      h('section', { class: 'stat-group' }, h('h2', { text: 'Most read sites' }),
        s.topSites.length ? h('ol', { class: 'rank' }, s.topSites.map(([site, n]) => h('li', {}, h('span', { text: site }), h('span', { class: 'n', text: `${fmtInt(n)} ch` })))) : h('p', { class: 'muted', text: 'Nothing read yet.' })),
      h('section', { class: 'stat-group' }, h('h2', { text: 'Top tags' }),
        s.topTags.length ? h('div', { class: 'tags' }, s.topTags.map(([t, n]) => h('span', { class: 'chip' }, labelFor('tag', t), h('span', { class: 'n', text: String(n) })))) : h('p', { class: 'muted', text: 'No tags yet.' }))),
  );
}

// ---------------------------------------------------------------------------------------
// import / export

let fileText = null;
async function dryRun() {
  const box = clear($('summary'));
  if (!fileText) return;
  const mode = document.querySelector('input[name=mode]:checked').value;
  const source = document.querySelector('input[name=source]:checked').value;
  box.append(h('p', { class: 'muted', text: 'Analysing…' }));
  let r;
  try { r = await send('importFile', { text: fileText, mode, source, apply: false }); }
  catch (e) { clear(box).append(h('p', { class: 'err-text', text: 'Cannot import: ' + e.message })); return; }
  const s = r.summary;
  const names = (list) => h('ul', {}, list.slice(0, 200).map((x) => h('li', { text: `${x.name} (${x.siteId})` })));
  clear(box).append(h('div', { class: 'summary' },
    h('h2', { text: `Dry run — ${mode === 'replace' ? 'replace' : 'merge'}` }),
    h('p', { class: 'muted small', text: mode === 'replace'
      ? 'Series not in the file are deleted on all devices; series in the file are kept and merged like sync (newer reading and edits are never rolled back).'
      : 'Series from the file are merged in like sync (newer reading and edits win).' }),
    s.syncWarning ? h('p', { class: 'err-text small', text: s.syncWarning }) : null,
    h('dl', {},
      h('dt', { text: 'In file' }), h('dd', { text: `${s.fileEntries} entries, ${s.fileCovers} covers` }),
      h('dt', { text: 'New' }), h('dd', { text: String(s.added.length) }),
      h('dt', { text: 'Updated' }), h('dd', { text: String(s.updated.length) }),
      h('dt', { text: 'Unchanged' }), h('dd', { text: String(s.unchanged) }),
      mode === 'replace' || s.removed.length ? [h('dt', { text: 'Removed from library' }), h('dd', { class: s.removed.length ? 'err-text' : '', text: String(s.removed.length) })] : null,
      s.skippedDeleted.length ? [h('dt', { text: 'Deleted here — not re-added' }), h('dd', { text: `${s.skippedDeleted.length} (use Replace to bring them back)` })] : null,
      s.restored.length ? [h('dt', { text: 'Restored (were deleted)' }), h('dd', { text: String(s.restored.length) })] : null,
      h('dt', { text: 'New covers' }), h('dd', { text: String(s.newCovers) }),
      h('dt', { text: 'Covers missing everywhere' }), h('dd', { text: `${s.missingCovers.length} (kept as references)` }),
      s.unverifiedCovers.length ? [h('dt', { text: 'Covers not matching their key' }), h('dd', { class: 'err-text', text: `${s.unverifiedCovers.length} (kept for export, not synced)` })] : null,
      h('dt', { text: 'File' }), h('dd', { text: s.kind === 'shiori' ? 'Shiori backup' : s.kind === 'snapshot' ? 'Server snapshot (covers come from your server)' : 'MangaPin export' }),
      s.problemCount ? [h('dt', { text: 'Warnings' }), h('dd', { text: String(s.problemCount) })] : null,
    ),
    s.added.length ? h('details', {}, h('summary', { text: 'New entries' }), names(s.added)) : null,
    s.updated.length ? h('details', {}, h('summary', { text: 'Updated entries' }), names(s.updated)) : null,
    s.removed.length ? h('details', { attrs: { open: true } }, h('summary', { text: 'Entries that will be deleted' }), names(s.removed)) : null,
    s.problems.length ? h('details', {}, h('summary', { text: 'Warnings' }), h('ul', {}, s.problems.map((p) => h('li', { text: p })))) : null,
    h('div', { class: 'row tight' },
      h('button', { type: 'button', text: mode === 'replace' ? `Replace library (${s.fileEntries} entries)` : `Merge ${s.added.length + s.updated.length} changes`, on: { click: async (ev) => {
        if (s.removed.length && !(await confirmBox(mode === 'replace' ? 'Replace your library?' : 'Import this file?',
          mode === 'replace' ? `${s.removed.length} series that are not in the file will be deleted on all synced devices.` : `${s.removed.length} series deleted on the device this backup came from will be deleted here and on all synced devices.`,
          mode === 'replace' ? 'Replace library' : 'Import'))) return;
        ev.target.disabled = true;
        try {
          await send('importFile', { text: fileText, mode, source, apply: true, planId: s.planId });
          clear(box).append(h('p', { class: 'ok-text', text: `Imported. Library now has ${(await send('state')).count} entries.` }));
          state.covers = {};
          await load();
        } catch (e) {
          if (/^PLAN_CHANGED/.test(e.message)) { dryRun(); return; }
          box.append(h('p', { class: 'err-text', text: e.message })); ev.target.disabled = false;
        }
      } } }),
    ),
  ));
}
$('file').addEventListener('change', async () => {
  const file = $('file').files[0];
  fileText = file ? await file.text() : null;
  dryRun();
});
for (const r of document.querySelectorAll('input[name=mode], input[name=source]')) r.addEventListener('change', dryRun);

$('export').addEventListener('click', async () => {
  $('exportMsg').textContent = 'Building…';
  try {
    const { name, text } = await send('exportFile');
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = h('a', { attrs: { download: name } });
    a.href = url;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    $('exportMsg').textContent = `${name} (${(text.length / 1024 / 1024).toFixed(2)} MB)`;
  } catch (e) { $('exportMsg').textContent = e.message; }
});

// ---------------------------------------------------------------------------------------
// settings

async function renderSettings() {
  const st = await send('state');
  state.st = st;
  const form = $('settings');
  form.davUrl.value = st.cfg.davUrl || '';
  form.user.value = st.cfg.user || '';
  form.token.value = '';
  form.token.placeholder = st.hasToken ? '(saved — leave empty to keep)' : 'paste app token';
  form.autoSync.checked = !!st.cfg.autoSync;
  form.releaseChecks.checked = !!st.cfg.releaseChecks;
  if (state.lib) {
    clear(form.releaseFolder).append(...knownKeys('folder').map((v) => h('option', { value: v, text: labelFor('folder', v), selected: v === st.cfg.releaseFolder })));
  }
  try {
    const all = await api.permissions.contains({ origins: ['<all_urls>'] });
    $('hostAccess').hidden = all;
  } catch { $('hostAccess').hidden = true; }
  const s = st.sync;
  clear($('status')).append(h('dl', { class: 'summary' },
    h('dt', { text: 'Library' }), h('dd', { text: `${st.count} entries, ${st.covers} covers stored locally` }),
    h('dt', { text: 'Last successful sync' }), h('dd', { text: s.lastOk ? `${new Date(s.lastOk).toLocaleString()} (${ago(s.lastOk)})` : 'never' }),
    h('dt', { text: 'Last attempt' }), h('dd', { text: s.lastAttempt ? new Date(s.lastAttempt).toLocaleString() : 'never' }),
    h('dt', { text: 'Pending local changes' }), h('dd', { text: s.dirty ? 'yes' : 'no' }),
    s.lastError ? [h('dt', { text: 'Last error' }), h('dd', { class: 'err-text', text: s.lastError })] : null,
    s.lastStats ? [h('dt', { text: 'Last sync' }), h('dd', { text: `pushed: ${s.lastStats.pushed ? 'yes' : 'no'}, pulled ${s.lastStats.pulled} entries, covers ↑${s.lastStats.coversUp} ↓${s.lastStats.coversDown}, 412 retries ${s.lastStats.conflicts}` })] : null,
  ));
}

function formCfg() {
  const form = $('settings');
  return {
    cfg: { davUrl: form.davUrl.value.trim(), user: form.user.value.trim(), autoSync: form.autoSync.checked, releaseChecks: form.releaseChecks.checked, releaseFolder: Number(form.releaseFolder.value) || 1 },
    token: form.token.value,
  };
}
function ensureHostPermission(url) {
  // Firefox MV3 treats host permissions as optional until granted. request() must be the first
  // await in the click handler (user gesture); it resolves true at once when already granted.
  try { return api.permissions.request({ origins: [new URL(url).origin + '/*'] }).catch(() => false); } catch { return Promise.resolve(false); }
}
$('settings').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const { cfg, token } = formCfg();
  const msg = $('settingsMsg');
  if (!safeHttpUrl(cfg.davUrl)) { msg.textContent = 'URL must be http(s)'; msg.className = 'small err-text'; return; }
  await ensureHostPermission(cfg.davUrl); // first await: keeps the user gesture for Firefox
  let saved;
  try { ({ cfg: saved } = await send('saveSettings', { cfg, token: token || undefined })); }
  catch (e) { msg.textContent = e.message; msg.className = 'small err-text'; return; }
  msg.textContent = saved.davUrl !== cfg.davUrl ? `Saved. WebDAV folder: ${saved.davUrl}` : 'Saved.'; msg.className = 'small ok-text';
  renderSettings();
});
$('test').addEventListener('click', async () => {
  const { cfg, token } = formCfg();
  const msg = $('settingsMsg');
  msg.textContent = 'Testing…'; msg.className = 'small';
  await ensureHostPermission(cfg.davUrl);
  const r = await send('testConnection', { cfg, token: token || undefined });
  if (r.ok && r.davUrl) $('settings').davUrl.value = r.davUrl; // a bare server address, completed
  msg.textContent = r.ok ? r.message : r.error;
  msg.className = 'small ' + (r.ok ? 'ok-text' : 'err-text');
});

$('grantHosts').addEventListener('click', async () => {
  try { await api.permissions.request({ origins: ['<all_urls>'] }); } catch { /* user said no */ }
  renderSettings();
});

// ---------------------------------------------------------------------------------------
// labels

function labelRow(kind, key, name) {
  return h('div', { class: 'row tight' },
    h('input', { class: 'key', type: 'number', step: 1, value: key, attrs: { 'aria-label': `${kind} number` } }),
    h('input', { class: 'grow', type: 'text', value: name, placeholder: 'name', attrs: { 'aria-label': `${kind} name` } }),
    h('button', { type: 'button', class: 'ghost icon', text: '✕', attrs: { 'aria-label': 'remove' }, on: { click: (ev) => ev.target.closest('.row').remove() } }));
}
let labelsBase = { folder: {}, type: {}, tag: {} }; // names as rendered: only changes are saved
function renderLabels() {
  if (!state.lib) return;
  labelsBase = { folder: {} };
  for (const card of document.querySelectorAll('.labels .card')) {
    const kind = card.dataset.kind;
    const rows = clear(card.querySelector('.rows'));
    for (const k of knownKeys(kind)) {
      const n = labelName(state.lib.labels, kind, k) || '';
      if (n) labelsBase[kind][String(k)] = n;
      rows.append(labelRow(kind, k, n));
    }
    card.querySelector('.add').onclick = () => rows.append(labelRow(kind, '', ''));
  }
}
$('saveLabels').addEventListener('click', async () => {
  const labels = { folder: {} };
  for (const card of document.querySelectorAll('.labels .card')) {
    for (const row of card.querySelectorAll('.rows .row')) {
      const [k, n] = row.querySelectorAll('input');
      if (k.value === '' || !n.value.trim()) continue;
      labels[card.dataset.kind][String(Math.trunc(Number(k.value)))] = n.value.trim();
    }
  }
  try {
    await send('saveLabels', { labels, base: labelsBase });
    $('labelsMsg').textContent = 'Saved.'; $('labelsMsg').className = 'small ok-text';
    await load(); renderLabels();
  } catch (e) { $('labelsMsg').textContent = e.message; $('labelsMsg').className = 'small err-text'; }
});

// ---------------------------------------------------------------------------------------

$('syncNow').addEventListener('click', async () => {
  $('sync').textContent = 'Syncing…';
  const r = await send('syncNow').catch((e) => ({ ok: false, error: e.message }));
  if (r && r.skipped) { showTab('settings'); }
  await load();
});
let reloadTimer = null;
api.runtime.onMessage.addListener((m) => {
  if (!m || (m.type !== 'changed' && m.type !== 'sync')) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => load().catch(() => {}), 300);
});

load().then(() => {
  let tab = 'library', folder = '';
  try { tab = localStorage.getItem('shiori.tab') || 'library'; folder = localStorage.getItem('shiori.folder') || ''; } catch { /* ignore */ }
  showTab(tab, folder);
}).catch((e) => { clear($('grid')).append(h('p', { class: 'err-text', text: 'Error: ' + e.message })); });
