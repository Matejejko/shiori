// The reading indicator on manga pages (bottom right). The background injects
// renderPageIndicator(info) into the tab with scripting.executeScript, so the function must be
// self-contained: no imports, no outside variables. It runs in the extension's isolated world,
// renders into a closed shadow root (the page can't read your progress from it or restyle it),
// sets text only (never HTML), and its one action — Pin — asks the background to pin this tab.

/** @param {null | {state:'pinned'|'seen'|'new', read:number|null, latest?:number|null, here:number|null, nextChap?:number|null, nextUrl?:string|null}} info */
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

  const style = el('style');
  style.textContent = `
    :host { all: initial; }
    .box { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: flex; align-items: center; gap: 10px;
      padding: 8px 8px 8px 10px; border-radius: 12px; font: 500 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
      background: #ffffff; color: #1f1d1a; border: 1px solid #e3ded6; box-shadow: 0 6px 24px rgba(0,0,0,.18); max-width: calc(100vw - 32px); }
    .mark { width: 10px; height: 16px; background: #c2410c; clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 75%, 0 100%); flex: none; }
    .txt { display: flex; flex-direction: column; min-width: 0; }
    .lbl { font-size: 11px; color: #6b665e; }
    .main { font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .of { font-weight: 500; color: #6b665e; }
    .btn { all: unset; cursor: pointer; padding: 6px 10px; border-radius: 8px; background: #c2410c; color: #fff; font-weight: 650; white-space: nowrap; }
    .btn:focus-visible, .x:focus-visible { outline: 2px solid #c2410c; outline-offset: 2px; }
    .x { all: unset; cursor: pointer; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 6px; color: #6b665e; font-size: 15px; }
    .x:hover { background: rgba(0,0,0,.06); }
    @media (prefers-color-scheme: dark) {
      .box { background: #22201d; color: #ece8e1; border-color: #37332e; box-shadow: 0 6px 24px rgba(0,0,0,.5); }
      .lbl, .of, .x { color: #a39d93; } .mark { background: #ea580c; } .btn { background: #f97316; color: #1b1209; } .x:hover { background: rgba(255,255,255,.08); }
    }`;

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

  if (info.state === 'pinned' && has(info.nextChap) && typeof info.nextUrl === 'string' && /^https?:\/\//i.test(info.nextUrl) && (!has(info.here) || info.nextChap > info.here)) {
    const a = el('a', 'btn', `Continue ch ${ch(info.nextChap)}`);
    a.href = info.nextUrl;
    a.dataset.act = 'continue';
    box.append(a);
  } else if (info.state !== 'pinned') {
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
