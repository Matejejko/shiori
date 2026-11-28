// Applies your theme and accent before the page is drawn (no white flash in dark mode). A plain
// script, not a module, so it runs before first paint; ui/dom.js applyTheme keeps this cache current.
try {
  const look = JSON.parse(localStorage.getItem('shiori.look') || '{}');
  const r = document.documentElement;
  if (look.theme === 'light' || look.theme === 'dark') r.dataset.theme = look.theme;
  if (/^#[0-9a-f]{6}$/i.test(look.accent || '')) {
    r.style.setProperty('--ai', look.accent);
    r.style.setProperty('--ai-ink', '#ffffff');
    r.style.setProperty('--ai-soft', `color-mix(in srgb, ${look.accent} 16%, var(--sheet))`);
  }
} catch { /* no storage: follow the system */ }
