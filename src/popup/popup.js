import { api, h, clear, send, fmtChap, coverUrl, syncSummary, folderName, safeHttpUrl } from '../ui/dom.js';

const $ = (id) => document.getElementById(id);
let tabId = null;

async function renderSync() {
  const st = await send('state');
  const s = syncSummary(st.sync, st.cfg, st.hasToken);
  const pill = $('sync');
  pill.className = 'pill ' + s.cls;
  pill.textContent = s.cls === 'err' ? 'Sync error' : s.cls === 'off' ? 'Not synced' : s.text;
  pill.title = s.text;
  return st;
}

function cover(e, covers, cls = 'thumb') {
  const url = e.img && covers[e.img] ? coverUrl(e.img, covers[e.img]) : null;
  return url ? h('img', { class: cls, src: url, attrs: { alt: '' } }) : h('div', { class: cls + ' none', attrs: { 'aria-hidden': 'true' } });
}

async function renderCurrent(lib, covers) {
  const box = clear($('current'));
  if (tabId === null) { box.append(h('p', { class: 'muted', text: 'No active tab.' })); return; }
  let cur;
  try { cur = await send('currentTab', { tabId }); } catch (e) { box.append(h('p', { class: 'muted', text: e.message })); return; }
  if (!cur.url || !/^https?:/.test(cur.url)) { box.append(h('p', { class: 'muted', text: 'Open a manga page to track or pin it.' })); return; }

  if (cur.entry) {
    const e = cur.entry;
    const p = e.progress?.chap, l = e.latest?.chap;
    const chapHere = cur.match && cur.match.kind === 'chapter' ? cur.match.chap : null;
    const input = h('input', { type: 'number', step: 'any', min: 0, value: p ?? '', attrs: { 'aria-label': 'Chapter read' }, class: 'chap' });
    const msg = h('span', { class: 'muted small' });
    box.append(
      h('div', { class: 'row now' },
        cover(e, covers, 'cover'),
        h('div', { class: 'grow' },
          h('div', { class: 'title', text: e.name }),
          h('div', { class: 'muted small line' }, h('span', { text: cur.site || e.siteId }), h('span', { text: folderName(lib.labels, e.folder) })),
          h('div', { class: 'small read', text: `Read ${fmtChap(p)} / latest ${fmtChap(l)}` }),
          typeof p === 'number' && typeof l === 'number' ? h('progress', { attrs: { max: l, value: Math.min(p, l), 'aria-hidden': 'true' } }) : null,
          chapHere !== null && chapHere !== undefined ? h('div', { class: 'small', text: `This page: chapter ${fmtChap(chapHere)}` }) : null,
        ),
      ),
      h('form', { class: 'row tight correct', on: { submit: async (ev) => {
        ev.preventDefault();
        const chap = input.value.trim() === '' ? NaN : Number(input.value);
        if (!Number.isFinite(chap) || chap < 0) { msg.textContent = 'Enter a chapter number'; return; }
        try {
          const r = await send('setProgress', { id: e.id, chap, manual: true });
          msg.textContent = r.ok ? 'Saved' : 'Unchanged';
          refresh();
        } catch (err) { msg.textContent = err.message; }
      } } },
        h('label', { class: 'small', text: 'Progress' }), input, h('button', { type: 'submit', class: 'ghost', text: 'Set' }), msg),
    );
    return;
  }

  if (cur.match && cur.match.siteId && !cur.match.slug) {
    box.append(h('div', { class: 'title', text: cur.site }), h('p', { class: 'muted small', text: 'Open a series or chapter page to pin or track it.' }));
    return;
  }
  if (cur.match || cur.url) {
    const supported = !!(cur.match && cur.match.siteId);
    const name = h('input', { type: 'text', placeholder: 'Name (leave empty: taken from the page)', attrs: { 'aria-label': 'Name' }, class: 'grow' });
    const folder = h('select', { attrs: { 'aria-label': 'Folder' } },
      [1, 2, 3, 4, 5].map((f) => h('option', { value: f, text: folderName(lib.labels, f) })));
    const status = h('span', { class: 'muted small' });
    const btn = h('button', { type: 'submit', text: 'Pin series' });
    box.append(
      h('div', { class: 'title', text: supported ? `${cur.site} series` : 'Not a known site' }),
      h('div', { class: 'muted small', text: supported
        ? (cur.match.kind === 'chapter' ? `Chapter ${fmtChap(cur.match.chap)} of “${cur.match.slug}”` : `“${cur.match.slug}”`)
        : 'Pinning uses this page’s hostname and path (generic site).' }),
      h('form', { class: 'stack', on: { submit: async (ev) => {
        ev.preventDefault();
        btn.disabled = true; status.textContent = 'Pinning… (fetching cover)';
        try {
          const r = await send('pin', { tabId, name: name.value, folder: Number(folder.value) });
          status.textContent = r.already ? 'Already pinned.' : r.cover ? 'Pinned.' : 'Pinned (no cover found).';
          refresh();
        } catch (err) { status.textContent = err.message; btn.disabled = false; }
      } } }, name, h('div', { class: 'row tight' }, folder, btn, status)),
    );
  }
}

async function renderUnread(lib, covers, cfg) {
  const ul = clear($('unread'));
  const list = lib.entries.filter((e) => e.folder === cfg.releaseFolder && typeof e.latest?.chap === 'number' && typeof e.progress?.chap === 'number' && e.latest.chap > e.progress.chap)
    .sort((a, b) => (b.latest.ts || 0) - (a.latest.ts || 0));
  $('unreadCount').textContent = list.length ? `(${list.length})` : '';
  if (!list.length) { ul.append(h('li', { class: 'muted small', text: 'Nothing new. Release checks run every 6 h.' })); return; }
  for (const e of list) {
    const u = lib.urls[e.id] || {};
    const target = safeHttpUrl(u.next) || safeHttpUrl(u.series);
    const behind = e.latest.chap - e.progress.chap;
    ul.append(h('li', {},
      h('a', { class: 'row item', href: target || undefined, on: { click: (ev) => { ev.preventDefault(); if (target) api.tabs.create({ url: target }); } } },
        cover(e, covers),
        h('span', { class: 'grow' },
          h('span', { class: 'title small', text: e.name }),
          h('span', { class: 'muted small block read', text: `${fmtChap(e.progress?.chap)} → ${fmtChap(e.latest.chap)}` })),
        behind > 0 && Number.isFinite(behind) ? h('span', { class: 'obi', text: `+${fmtChap(behind)}` }) : null,
      )));
  }
}

async function refresh() {
  const [st, lib] = await Promise.all([renderSync(), send('library')]);
  const keys = [...new Set(lib.entries.map((e) => e.img).filter(Boolean))];
  const covers = await send('covers', { keys });
  await Promise.all([renderCurrent(lib, covers), renderUnread(lib, covers, st.cfg)]);
}

$('openApp').addEventListener('click', () => { api.tabs.create({ url: api.runtime.getURL('src/app/app.html') }); window.close(); });
$('syncNow').addEventListener('click', async () => {
  $('sync').textContent = 'Syncing…';
  const r = await send('syncNow').catch((e) => ({ ok: false, error: e.message }));
  if (r && r.skipped) $('sync').textContent = 'Set up sync in Library → Settings';
  else await renderSync();
});
api.runtime.onMessage.addListener((m) => { if (m && (m.type === 'sync' || m.type === 'changed')) renderSync().catch(() => {}); });

(async () => {
  // ?tab=<id> lets the popup be opened as a page for a given tab (used by the e2e test)
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  if (forced) tabId = forced;
  else {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    tabId = tab ? tab.id : null;
  }
  await refresh();
})().catch((e) => { clear($('current')).append(h('p', { class: 'muted', text: 'Error: ' + e.message })); });
