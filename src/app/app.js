import { api, h, clear, send, fmtChap, ago, coverUrl, syncSummary, labelName, folderName, safeHttpUrl } from '../ui/dom.js';
import { formPatch } from '../lib/library.js';

const $ = (id) => document.getElementById(id);
const state = { lib: null, covers: {}, st: null };

// ---------------------------------------------------------------------------------------
// tabs

function showTab(name) {
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('on', b.dataset.tab === name);
  for (const p of document.querySelectorAll('.pane')) p.hidden = p.id !== 'tab-' + name;
  try { localStorage.setItem('shiori.tab', name); } catch { /* ignore */ }
  if (name === 'settings') renderSettings();
  if (name === 'labels') renderLabels();
}
for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => showTab(b.dataset.tab));

// ---------------------------------------------------------------------------------------
// data

async function load() {
  const [st, lib] = await Promise.all([send('state'), send('library')]);
  state.st = st; state.lib = lib;
  const keys = [...new Set(lib.entries.map((e) => e.img).filter((k) => k && !(k in state.covers)))];
  if (keys.length) Object.assign(state.covers, await send('covers', { keys }));
  renderSyncPill();
  renderFilters();
  renderGrid();
}

function renderSyncPill() {
  const s = syncSummary(state.st.sync, state.st.cfg, state.st.hasToken);
  $('sync').className = 'pill ' + s.cls;
  $('sync').textContent = s.cls === 'err' ? 'Sync error' : s.text;
  $('sync').title = s.text;
}

const distinct = (arr) => [...new Set(arr)].sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))));
function knownKeys(kind) {
  const fromEntries = state.lib.entries.flatMap((e) => (kind === 'tag' ? (Array.isArray(e.tags) ? e.tags : []) : e[kind] !== undefined ? [e[kind]] : []));
  const fromLabels = Object.entries(state.lib.labels?.[kind] || {}).filter(([, v]) => v && v.name).map(([k]) => Number(k));
  const base = kind === 'folder' ? [1, 2, 4] : [];
  return distinct([...base, ...fromEntries, ...fromLabels].filter((x) => typeof x === 'number' && Number.isFinite(x)));
}
const labelFor = (kind, v) => labelName(state.lib.labels, kind, v) || (kind === 'folder' ? `Folder ${v}` : kind === 'type' ? `Type ${v}` : `Tag ${v}`);

function fillSelect(sel, all, items) {
  const cur = sel.value;
  clear(sel).append(h('option', { value: '', text: all }), ...items.map(([v, t]) => h('option', { value: v, text: t })));
  sel.value = items.some(([v]) => String(v) === cur) ? cur : '';
}
function renderFilters() {
  fillSelect($('fFolder'), 'All folders', knownKeys('folder').map((f) => [f, labelFor('folder', f)]));
  fillSelect($('fType'), 'Any type', knownKeys('type').map((f) => [f, labelFor('type', f)]));
  fillSelect($('fTag'), 'Any tag', knownKeys('tag').map((f) => [f, labelFor('tag', f)]));
  fillSelect($('fSite'), 'All sites', distinct(state.lib.entries.map((e) => e.siteId)).map((s) => [s, s]));
}

const unreadBy = (e) => (typeof e.latest?.chap === 'number' && typeof e.progress?.chap === 'number' ? Math.max(0, e.latest.chap - e.progress.chap) : 0);

function renderGrid() {
  const q = $('q').value.trim().toLowerCase();
  const f = { folder: $('fFolder').value, type: $('fType').value, tag: $('fTag').value, site: $('fSite').value, unread: $('fUnread').checked };
  let list = state.lib.entries.filter((e) => {
    if (q && !(`${e.name} ${e.siteId} ${e.slug}`.toLowerCase().includes(q))) return false;
    if (f.folder && String(e.folder) !== f.folder) return false;
    if (f.type && String(e.type) !== f.type) return false;
    if (f.tag && !(Array.isArray(e.tags) && e.tags.map(String).includes(f.tag))) return false;
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
      url ? h('img', { class: 'art', src: url, attrs: { alt: '', loading: 'lazy' } }) : h('div', { class: 'art' }),
      h('div', { class: 'meta' },
        h('span', { class: 'name', text: e.name }),
        h('span', { class: 'muted small', text: `${e.siteId} · ${labelFor('folder', e.folder)}` }),
        h('span', { class: 'small', text: typeof e.progress?.chap === 'number' ? `Read ${fmtChap(e.progress.chap)} / ${fmtChap(e.latest?.chap)}` : `Not started${typeof e.latest?.chap === 'number' ? ` · ${fmtChap(e.latest.chap)} ch` : ''}` }),
        n > 0 ? h('span', { class: 'badge', text: `+${fmtChap(n)}` }) : null,
        err ? h('span', { class: 'small err-text', text: 'check failed', attrs: { title: err.error } }) : null,
      )));
  }
  if (!list.length) grid.append(h('p', { class: 'muted', text: state.lib.entries.length ? 'No series match the filters.' : 'Library is empty — import a MangaPin export or pin a series from the popup.' }));
}

for (const id of ['q', 'fFolder', 'fType', 'fTag', 'fSite', 'fUnread', 'sort']) $(id).addEventListener('input', renderGrid);
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
    tags: h('select', { multiple: true, attrs: { size: 5 } }, knownKeys('tag').map((v) => h('option', { value: v, text: labelFor('tag', v), selected: Array.isArray(e.tags) && e.tags.includes(v) }))),
    newTag: h('input', { type: 'number', step: 1, placeholder: 'new tag #' }),
    score: h('input', { type: 'number', step: 'any', value: numOrEmpty(e.score) }),
    startTs: h('input', { type: 'date', value: toDateInput(e.startTs) }),
    endTs: h('input', { type: 'date', value: toDateInput(e.endTs) }),
    progress: h('input', { type: 'number', step: 'any', min: 0, value: numOrEmpty(e.progress?.chap) }),
  };
  // values as shown; Save sends only what differs from this snapshot (see formPatch)
  const readForm = () => ({
    name: f.name.value.trim(), url: f.url.value.trim() || undefined, folder: Number(f.folder.value),
    type: f.type.value === '' ? undefined : Number(f.type.value),
    tags: [...f.tags.selectedOptions].map((o) => Number(o.value)).concat(f.newTag.value !== '' ? [Number(f.newTag.value)] : []),
    score: f.score.value === '' ? undefined : Number(f.score.value),
    startTs: f.startTs.value === toDateInput(e.startTs) ? e.startTs : fromDateInput(f.startTs.value),
    endTs: f.endTs.value === toDateInput(e.endTs) ? e.endTs : fromDateInput(f.endTs.value),
  });
  const init = { ...readForm(), progress: f.progress.value };
  const msg = h('span', { class: 'small' });
  const seriesLink = safeHttpUrl(e.url || urls.series);
  const nextLink = safeHttpUrl(urls.next);
  dlg.append(h('form', { class: 'stack', attrs: { method: 'dialog' }, on: { submit: async (ev) => {
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
    h('div', { class: 'row' },
      e.img && state.covers[e.img] ? h('img', { class: 'cover', src: coverUrl(e.img, state.covers[e.img]), attrs: { alt: '' } }) : h('div', { class: 'cover' }),
      h('div', { class: 'grow stack' },
        h('div', { class: 'title', text: e.name }),
        h('div', { class: 'muted small', text: `${e.siteId} / ${e.slug}` }),
        h('div', { class: 'small', text: `Read ${fmtChap(e.progress?.chap)} · latest ${fmtChap(e.latest?.chap)}${e.latest?.ts ? ` (${ago(e.latest.ts)})` : ''}` }),
        h('div', { class: 'row tight' },
          seriesLink ? h('a', { href: seriesLink, text: 'Open series', target: '_blank', rel: 'noopener noreferrer' }) : null,
          nextLink ? h('a', { href: nextLink, text: `Next: ch ${fmtChap(e.next?.chap)}`, target: '_blank', rel: 'noopener noreferrer' }) : null),
      )),
    h('div', { class: 'form-grid' },
      h('label', { class: 'full' }, 'Name', f.name),
      h('label', { class: 'full' }, 'Series URL (optional; rebuilt from site + slug when empty)', f.url),
      h('label', {}, 'Folder', f.folder),
      h('label', {}, 'Type', f.type),
      h('label', {}, 'Tags (ctrl/cmd-click)', f.tags),
      h('label', {}, 'Add tag number', f.newTag),
      h('label', {}, 'Score', f.score),
      h('label', {}, 'Progress (chapter)', f.progress),
      h('label', {}, 'Started', f.startTs),
      h('label', {}, 'Finished', f.endTs),
    ),
    h('div', { class: 'row tight' },
      h('button', { type: 'submit', text: 'Save' }),
      h('button', { type: 'button', class: 'ghost', text: 'Check releases', on: { click: async () => {
        msg.textContent = 'Checking…';
        try {
          const r = await send('checkReleases', { ids: [id], force: true });
          msg.textContent = r.errors.length ? 'Failed: ' + r.errors[0].error : r.changed ? 'Updated.' : 'No new chapters.';
          await load();
        } catch (err) { msg.textContent = err.message; }
      } } }),
      h('button', { type: 'button', class: 'ghost', text: 'Cancel', on: { click: () => dlg.close() } }),
      h('button', { type: 'button', class: 'danger', text: 'Delete', on: { click: async () => {
        if (!confirm(`Delete “${e.name}” from the library? This syncs to your other devices.`)) return;
        await send('remove', { id });
        dlg.close();
        await load();
      } } }),
      msg),
  ));
  dlg.showModal();
}

// ---------------------------------------------------------------------------------------
// import / export

let fileText = null;
async function dryRun() {
  const box = clear($('summary'));
  if (!fileText) return;
  const mode = document.querySelector('input[name=mode]:checked').value;
  box.append(h('p', { class: 'muted', text: 'Analysing…' }));
  let r;
  try { r = await send('importFile', { text: fileText, mode, apply: false }); }
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
      mode === 'replace' ? [h('dt', { text: 'Removed from library' }), h('dd', { class: s.removed.length ? 'err-text' : '', text: String(s.removed.length) })] : null,
      s.skippedDeleted.length ? [h('dt', { text: 'Deleted here — not re-added' }), h('dd', { text: `${s.skippedDeleted.length} (use Replace to bring them back)` })] : null,
      s.restored.length ? [h('dt', { text: 'Restored (were deleted)' }), h('dd', { text: String(s.restored.length) })] : null,
      h('dt', { text: 'New covers' }), h('dd', { text: String(s.newCovers) }),
      h('dt', { text: 'Covers missing everywhere' }), h('dd', { text: `${s.missingCovers.length} (kept as references)` }),
      s.unverifiedCovers.length ? [h('dt', { text: 'Covers not matching their key' }), h('dd', { class: 'err-text', text: `${s.unverifiedCovers.length} (kept for export, not synced)` })] : null,
      h('dt', { text: 'Re-export byte-identical to this file' }), h('dd', { text: s.exact ? 'yes' : 'no (other data is merged in, or the file has duplicates/odd entries)' }),
      s.duplicateSeries.length ? [h('dt', { text: 'Same series twice' }), h('dd', { text: `${s.duplicateSeries.length} (different ids, kept both)` })] : null,
      s.problemCount ? [h('dt', { text: 'Warnings' }), h('dd', { text: String(s.problemCount) })] : null,
    ),
    s.added.length ? h('details', {}, h('summary', { text: 'New entries' }), names(s.added)) : null,
    s.updated.length ? h('details', {}, h('summary', { text: 'Updated entries' }), names(s.updated)) : null,
    s.removed.length ? h('details', { attrs: { open: true } }, h('summary', { text: 'Entries that will be deleted' }), names(s.removed)) : null,
    s.problems.length ? h('details', {}, h('summary', { text: 'Warnings' }), h('ul', {}, s.problems.map((p) => h('li', { text: p })))) : null,
    h('div', { class: 'row tight' },
      h('button', { type: 'button', text: mode === 'replace' ? `Replace library (${s.fileEntries} entries)` : `Merge ${s.added.length + s.updated.length} changes`, on: { click: async (ev) => {
        if (mode === 'replace' && s.removed.length && !confirm(`This deletes ${s.removed.length} entries that are not in the file (on all synced devices). Continue?`)) return;
        ev.target.disabled = true;
        try {
          await send('importFile', { text: fileText, mode, apply: true, planId: s.planId });
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
for (const r of document.querySelectorAll('input[name=mode]')) r.addEventListener('change', dryRun);

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
  await send('saveSettings', { cfg, token: token || undefined });
  msg.textContent = 'Saved.'; msg.className = 'small ok-text';
  renderSettings();
});
$('test').addEventListener('click', async () => {
  const { cfg, token } = formCfg();
  const msg = $('settingsMsg');
  msg.textContent = 'Testing…'; msg.className = 'small';
  await ensureHostPermission(cfg.davUrl);
  const r = await send('testConnection', { cfg, token: token || undefined });
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
    h('button', { type: 'button', class: 'ghost', text: '✕', attrs: { 'aria-label': 'remove' }, on: { click: (ev) => ev.target.closest('.row').remove() } }));
}
let labelsBase = { folder: {}, type: {}, tag: {} }; // names as rendered: only changes are saved
function renderLabels() {
  if (!state.lib) return;
  labelsBase = { folder: {}, type: {}, tag: {} };
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
  const labels = { folder: {}, type: {}, tag: {} };
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
  let tab = 'library';
  try { tab = localStorage.getItem('shiori.tab') || 'library'; } catch { /* ignore */ }
  showTab(tab);
}).catch((e) => { clear($('grid')).append(h('p', { class: 'err-text', text: 'Error: ' + e.message })); });
