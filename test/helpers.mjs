import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, 'fixtures');

/**
 * Every MangaPin export the fixture-driven tests run against:
 *  - test/fixtures/synthetic-export.json (committed, generated)
 *  - test/fixtures/private/*.json       (gitignored: put your real export here)
 *  - $SHIORI_EXPORT                      (path to an export anywhere)
 */
export function exportFixtures() {
  const list = [];
  const add = (p) => list.push({ name: basename(p), path: p, text: readFileSync(p, 'utf8') });
  add(join(FIXTURES, 'synthetic-export.json'));
  const priv = join(FIXTURES, 'private');
  if (existsSync(priv)) for (const f of readdirSync(priv).sort()) if (f.endsWith('.json')) add(join(priv, f));
  if (process.env.SHIORI_EXPORT) add(process.env.SHIORI_EXPORT);
  return list;
}

export function realExportPresent() {
  return exportFixtures().length > 1;
}

/** Deterministic PRNG for property tests. */
export function prng(seed = 42) {
  let s = seed >>> 0;
  const next = () => ((s = (s + 0x6d2b79f5) >>> 0), (() => {
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  })());
  return {
    next,
    int: (a, b) => a + Math.floor(next() * (b - a + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    bool: (p = 0.5) => next() < p,
  };
}

/** OpenCloud credentials for integration tests: env vars, $SHIORI_DAV_ENV or test/opencloud/env. */
export function davEnv() {
  const env = { url: process.env.SHIORI_DAV_URL, user: process.env.SHIORI_DAV_USER, token: process.env.SHIORI_DAV_TOKEN };
  const file = process.env.SHIORI_DAV_ENV || join(here, 'opencloud/env');
  if (!env.url && existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^(\w+)=(.*)$/.exec(line.trim());
      if (!m) continue;
      const v = m[2].replace(/^"(.*)"$/, '$1');
      if (m[1] === 'SHIORI_DAV_URL') env.url = v;
      if (m[1] === 'SHIORI_DAV_USER') env.user = v;
      if (m[1] === 'SHIORI_DAV_TOKEN') env.token = v;
    }
  }
  return env.url && env.user && env.token ? env : null;
}

/** Playwright (dev-only): local node_modules first, then a global install. */
export async function loadPlaywright() {
  try { return (await import('playwright')).default ?? (await import('playwright')); } catch { /* fall through */ }
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return createRequire(join(root, 'noop.js'))('playwright');
  } catch { return null; }
}
