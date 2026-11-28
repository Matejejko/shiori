// The reading indicator on manga pages (bottom right). The background injects
// renderPageIndicator(info) into the tab with scripting.executeScript, so the function must be
// self-contained: no imports, no outside variables. It runs in the extension's isolated world,
// renders into a closed shadow root (the page can't read your progress from it or restyle it),
// sets text only (never HTML), and its one action — Pin — asks the background to pin this tab.

/**
 * @param {null | {state:'pinned'|'seen'|'new', read:number|null, latest?:number|null, here:number|null,
 *   nextChap?:number|null, nextUrl?:string|null, theme?:'auto'|'light'|'dark', accent?:string}} info
 */
/**
 * Accent colours for all of Shiori (Settings). '' = Shiori's orange (#c2410c, brighter #f97316 in
 * dark mode); the others are dark enough for white text on them (contrast ≥ 4.5:1) in both themes.
 */
export const ACCENTS = [['Orange', ''], ['Red', '#b91c1c'], ['Pink', '#be185d'], ['Purple', '#7c3aed'], ['Blue', '#2563eb'], ['Teal', '#0f766e'], ['Green', '#15803d']];

export function renderPageIndicator(info) {
  const st = globalThis.__shioriIndicator || (globalThis.__shioriIndicator = {});
  if (!info || st.closedOn === location.href) { if (st.host) st.host.remove(); return; }
  if (!st.host || !st.host.isConnected) {
    st.host = document.createElement('div');
    st.root = st.host.attachShadow({ mode: 'closed' });
    document.documentElement.append(st.host);
  }
  // values can arrive as undefined instead of null (the injection serializes args): treat both as "none"
  const has = (v) => typeof v === 'number' && Number.isFinite(v);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const ch = (n) => String(n);

  // your look (Settings): theme and accent, as on Shiori's own pages
  const accent = /^#[0-9a-f]{6}$/i.test(info.accent || '') ? info.accent : null;
  const dark = `.box { --bg: #22201d; --ink: #ece8e1; --ink2: #a39d93; --line: #37332e; --hover: rgba(255,255,255,.08); --shadow: rgba(0,0,0,.5);${accent ? '' : ' --ac: #f97316; --acink: #1b1209;'} }`;
  const style = el('style');
  style.textContent = `
    :host { all: initial; }
    .box { --bg: #ffffff; --ink: #1f1d1a; --ink2: #6b665e; --line: #e3ded6; --hover: rgba(0,0,0,.06); --shadow: rgba(0,0,0,.18); --ac: ${accent || '#c2410c'}; --acink: #fff;
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: flex; align-items: center; gap: 10px;
      padding: 8px 8px 8px 10px; border-radius: 12px; font: 500 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
      background: var(--bg); color: var(--ink); border: 1px solid var(--line); box-shadow: 0 6px 24px var(--shadow); max-width: calc(100vw - 32px); }
    ${info.theme === 'dark' ? dark : info.theme === 'light' ? '' : `@media (prefers-color-scheme: dark) { ${dark} }`}
    .mark { width: 10px; height: 16px; background: var(--ac); clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 75%, 0 100%); flex: none; }
    .txt { display: flex; flex-direction: column; min-width: 0; }
    .lbl { font-size: 11px; color: var(--ink2); }
    .main { font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .of { font-weight: 500; color: var(--ink2); }
    .btn { all: unset; cursor: pointer; padding: 6px 10px; border-radius: 8px; background: var(--ac); color: var(--acink); font-weight: 650; white-space: nowrap; }
    .btn.ghost { background: transparent; color: var(--ink); box-shadow: inset 0 0 0 1px var(--line); }
    .btn:focus-visible, .x:focus-visible { outline: 2px solid var(--ac); outline-offset: 2px; }
    .x { all: unset; cursor: pointer; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 6px; color: var(--ink2); font-size: 15px; }
    .x:hover, .btn.ghost:hover { background: var(--hover); }`;

  const box = el('div', 'box');
  box.setAttribute('role', 'status');
  const txt = el('div', 'txt');
  const main = el('div', 'main');
  if (info.state === 'pinned') {
    txt.append(el('div', 'lbl', has(info.here) ? 'Shiori · saved' : 'Shiori · read up to'));
    const at = has(info.here) ? info.here : info.read;
    main.append(has(at) ? `Chapter ${ch(at)}` : 'Not started');
    if (has(at) && has(info.latest) && info.latest >= at) main.append(el('span', 'of', ` of ${ch(info.latest)}`));
  } else {
    txt.append(el('div', 'lbl', 'Shiori · not pinned'));
    main.append(has(info.read) ? `Read up to ch ${ch(info.read)}` : 'Not started');
  }
  txt.append(main);
  box.append(el('span', 'mark'), txt);

  // Continue (or Start reading) wherever the chapter is known — pinned or not
  if (has(info.nextChap) && typeof info.nextUrl === 'string' && /^https?:\/\//i.test(info.nextUrl) && (!has(info.here) || info.nextChap > info.here)) {
    const started = has(info.read) || has(info.here);
    const a = el('a', info.state === 'pinned' ? 'btn' : 'btn ghost', `${started ? 'Continue' : 'Start reading'} ch ${ch(info.nextChap)}`);
    a.href = info.nextUrl;
    a.dataset.act = 'continue';
    box.append(a);
  }
  if (info.state !== 'pinned') {
    const b = el('button', 'btn', 'Pin');
    b.type = 'button';
    b.dataset.act = 'pin';
    b.title = has(info.read) ? `Add to Shiori, starting at chapter ${ch(info.read)}` : 'Add to Shiori';
    b.addEventListener('click', () => {
      b.textContent = 'Pinning…';
      b.disabled = true;
      chrome.runtime.sendMessage({ type: 'pinFromPage' }).then((r) => { if (!r || !r.ok) b.textContent = 'Pin failed'; }, () => { b.textContent = 'Pin failed'; });
    });
    box.append(b);
  }
  const x = el('button', 'x', '×');
  x.type = 'button';
  x.dataset.act = 'close';
  x.setAttribute('aria-label', 'Hide the Shiori indicator on this page');
  x.addEventListener('click', () => { st.closedOn = location.href; st.host.remove(); });
  box.append(x);

  st.root.replaceChildren(style, box);
  // for the extension's own tests (this isolated world is invisible to the page)
  st.text = () => box.textContent;
  st.click = (act) => { const n = st.root.querySelector(`[data-act="${act}"]`); if (n) n.click(); return !!n; };
}
