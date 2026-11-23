# Shiori

Personal Manifest V3 manga tracker: pin series, follow your reading automatically, check for new
chapters, and sync your library to your own OpenCloud over WebDAV. The library *is* a MangaPin
library: you can import a MangaPin export, and export one back, at any time — unmodified data
round-trips byte-for-byte.

Vanilla ES modules, no build step, no runtime dependencies. Chromium first; the manifest also
loads in Firefox 128+.

## Install

- **Chrome / Chromium / Brave:** `chrome://extensions` → Developer mode → *Load unpacked* → this folder.
- **Firefox 128+:** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → `manifest.json`.
  Temporary add-ons disappear on restart; a permanent install needs the add-on signed (unlisted on
  AMO) or Developer Edition/Nightly with `xpinstall.signatures.required=false`. Firefox also asks
  for site access separately: Library → Settings shows a *Grant access* button when it is missing.

Permissions: `storage`, `unlimitedStorage`, `alarms`, `tabs` (tab URLs, for tracking), `scripting`
(read the series name and cover when pinning), and host access (release checks, covers, your server).

## Set up sync

1. In OpenCloud: Settings → App Tokens (or `opencloud auth-app create --user-name <you> --expiration 8760h`).
2. Library → Settings: WebDAV URL of your personal space, e.g.
   `https://oc.192.168.0.101.sslip.io/remote.php/webdav/` (also valid: `/dav/files/<user>/`),
   username, app token → *Test connection* → *Save*.
3. Sync runs 5 s after every change and every 15 min; the library lives in `/Shiori/`:
   - `library.json` — entries (verbatim MangaPin objects) + tombstones + labels + merge metadata
   - `covers/<bytes>-<md5>.webp` — content-addressed covers, uploaded once

The token is stored only in `chrome.storage.local` (`secret`), never in synced data, never logged.

### ⚠️ Your server's certificate will block this as configured

`oc.192.168.0.101.sslip.io` is served with **Traefik's default self-signed certificate**. Browser
extensions cannot bypass certificate errors (there is no "accept the risk" for `fetch`), so every
request fails with a network/TLS error until the browser trusts the certificate. Worse, Traefik
*generates a new default certificate on every restart*, so trusting it once is not enough.
Options (all on the server side, which this project does not touch):

- **Proper certificate** for a name you control (cert-manager + Let's Encrypt DNS-01 works for a
  private IP). Best: trusted by every browser and OS, no per-machine setup.
- **Own CA** (mkcert, or a cert-manager CA issuer) and install the CA on the MacBook (Keychain) and the
  CachyOS desktop (`trust anchor`). Firefox needs `security.enterprise_roots.enabled=true` or its own import.
- **Tailscale HTTPS** (`*.ts.net` certificate) — requires OpenCloud's `OC_URL` to use that name.

Also note: `*.sslip.io` needs public DNS. With no internet (or a resolver with DNS-rebinding
protection that drops private answers, e.g. some routers/Pi-hole/NextDNS setups) the name does not
resolve even on your LAN.

## How data is kept

- Entries are stored as raw JSON strings (`e:<id>`). `chrome.storage.local` returns objects with
  **alphabetically sorted keys**, so storing objects would silently break byte-identical export.
- Unknown fields (entry or top-level) survive import → edit → sync → export.
- `imgs` are written in first-reference order; covers referenced but missing from `imgs`
  (MangaPin loses some) are kept as references and reported in the import dry run.
- `folder`, `type` and `tags` stay raw numbers; Library → Labels gives them names (synced).
- Export filename: `MangaPinYYYYMMDDHHmm.json` (local time).

## How merging works (and where it deviates from the original plan)

Per entry id, every field group is a max over a total order, so the merge is commutative,
associative and idempotent (property-tested), and every device converges.

| group | rule |
|---|---|
| `progress` | max by **(epoch, chap, ts)** |
| `latest` | max by (chap, ts) |
| `next` | max by ts |
| everything else | whole group from the side with the newer *rest time* |
| `ts` | max |
| tombstone | wins only if newer than the last *user* edit or read |

Two deliberate deviations from "progress by newer progress.ts, rest by newer ts":

1. **Progress epochs.** Plain "newer progress.ts wins" regresses progress in exactly your setup: the
   desktop that was offline for days reads chapter 35 of a series you already finished to 50 on the
   laptop → its *newer* chapter 35 wins. Now auto-tracked progress within the same epoch compares by
   chapter, so that can't happen; a manual correction (popup/editor "Set") starts a new epoch and wins
   even if it goes backwards, and reading continues from it.
2. **Rest time ≠ entry.ts.** Release checks and tracking must bump `entry.ts` (MangaPin's invariant
   `ts ≥ nested ts`). With "rest by newer ts", a release check on the desktop would silently overwrite a
   folder/tag edit made on the offline laptop. Shiori keeps the time of the last *user edit* of the rest
   fields in a sidecar (`meta.r`), only in its own storage and `library.json` — never in MangaPin exports.

Import modes: **merge** (file entries merge in; progress joins your current epoch only if it is newer
than your last manual correction) and **replace** (the file becomes the truth as of now: its entries win
the next sync, everything not in the file is tombstoned on all devices). Both show a dry-run summary first.

### OpenCloud quirk you should know about

OpenCloud 9.2 **ignores `If-None-Match: *`** on PUT (it overwrites with 204 instead of 412). Shiori
therefore reads `library.json` back after creating it and re-merges if another device won the race;
anything still lost in that window is re-uploaded by the next sync because no device ever discards its
local data. `If-Match` works correctly (stale ETag → 412, atomic under parallel writers) and is what
every later write uses.

## Sites

| siteId | chapter list (no JavaScript) | notes |
|---|---|---|
| comix | **latest chapter only** (embedded page data) | full list API needs a token minted by obfuscated JS; chapter URLs need a per-chapter id → "next" is only set when it is the directly following chapter |
| vortex | JSON API (2 requests) | `vortexmanga.com` → `vortexscans.org` |
| thunder | chapter links in page | rotating numeric slug prefix is ignored when matching; links use the unprefixed series URL (redirects) |
| asura | JSON API `api.asurascans.com` | HTML is behind Cloudflare; rotating `-xxxxxxxx` hash ignored when matching; `asuracomic.net` URLs are rebuilt on `asurascans.com` |
| arena, kingofshojo | chapter links in page | MangaThemesia |
| rolia | JSON API (needs manga id: `rawId`, else read from the page) | |
| ezmanga | JSON API `vapi.ezmanga.org` (MangaPin's own endpoint) | site HTML is behind Cloudflare; chapter URL shape unverified |
| valir | page data (Next.js) | paged series (>1 page) are treated as partial |
| mangareadorg | chapter links in page, else Madara `POST …/ajax/chapters/` | |
| kagane | — | Cloudflare everywhere; reader URLs carry opaque ids, so chapters can't be tracked from the URL |
| hostnames (generic) | — | tracked by stored path/url; no release checks |

Release checks run for the folder chosen in Settings (default 1), each series at most every 6 h,
1.5 s apart per host. Sites that answer with a bot challenge are reported per series in the library
("check failed") instead of being retried in a loop.

## Tests

```bash
node --test
```

- **Your real export is not in this repo** (personal data). Put it at `test/fixtures/private/MangaPin*.json`
  (gitignored) or set `SHIORI_EXPORT=/path/to/export.json`; every fixture-driven test (byte-identical
  round trip, MD5 of every cover key, adapter round trip of every entry, headless import) then runs on
  it too. Until then they run on `test/fixtures/synthetic-export.json` (same shape: 103 entries, 91 covers,
  8 dangling cover references; regenerate with `node tools/make-fixture.mjs`).
- **OpenCloud integration** (two devices, interleaved edits, real 412s): `test/opencloud/start.sh`
  starts a throwaway OpenCloud on `127.0.0.1:9200` (linux/amd64 binary from the official image) and
  writes `test/opencloud/env`; or set `SHIORI_DAV_URL`, `SHIORI_DAV_USER`, `SHIORI_DAV_TOKEN`. Skipped otherwise.
- **Headless Chromium e2e** needs Playwright (`npm i -D playwright`, dev only). Skipped otherwise.

## Layout

```
manifest.json
src/background.js        all network I/O and all library writes (tracking, sync, release checks, pinning)
src/lib/                 pure modules: mangapin (format), merge, library, store, sync, webdav,
                         adapters + sites (site table), tracker, releases, cover, md5, base64
src/popup/  src/app/     UI (DOM built with textContent only — no innerHTML anywhere)
test/                    node:test suites, fixtures (incl. saved live site responses), OpenCloud scripts
tools/make-fixture.mjs   synthetic export generator
```
