# Shiori

Personal Manifest V3 manga tracker: pin series, follow your reading automatically, check for new
chapters, and sync your library to your own OpenCloud over WebDAV. The data format is Shiori's own
(versioned); entries keep MangaPin's field names, so a MangaPin export imports without losing anything.
Export writes a Shiori backup.

Vanilla ES modules, no build step, no runtime dependencies. Chromium first; the manifest also
loads in Firefox 128+.

## Install

- **Chrome / Chromium / Brave:** `chrome://extensions` → Developer mode → *Load unpacked* → this folder.
- **Firefox 128+:** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → `manifest.json`.
  Temporary add-ons disappear on restart; a permanent install needs the add-on signed (unlisted on
  AMO) or Developer Edition/Nightly with `xpinstall.signatures.required=false`. Firefox also asks
  for site access separately: Library → Settings shows a *Grant access* button when it is missing.

Permissions: `storage`, `unlimitedStorage`, `alarms`, `tabs` (tab URLs, for tracking), `scripting`
(read the series name and cover URL when pinning), and host access (release checks, covers, your server).
All network requests come from the background worker; covers from CDNs that insist on the page as Referer
can't be fetched, and such series are pinned without a cover.

## Set up sync

1. In OpenCloud: Settings → App Tokens (or `opencloud auth-app create --user-name <you> --expiration 8760h`).
2. Library → ☰ → Sync settings: the WebDAV URL of your personal space, e.g.
   `https://cloud.example.com/remote.php/webdav/` (also valid: `/dav/files/<user>/`; the bare server
   address works too — *Test connection* / *Save* find the folder), username, app token →
   *Test connection* → *Save*. Nextcloud and other WebDAV servers should work; only OpenCloud is tested.
3. Sync runs 5 s after every change and every 15 min; the library lives in `/Shiori/`:
   - `library.json` — entries + tombstones + labels + merge metadata (`format: shiori-library`, `version`).
     A device that meets a newer `version` stops syncing and asks to be updated instead of rewriting it.
   - `covers/<bytes>-<md5>.webp` — content-addressed covers, uploaded once, never deleted
   - `backups/library-YYYY-MM-DD.json` — the server's `library.json` as it was before the first change of
     each day, plus `library-…-before-import.json` before the push that follows a *replace* import; the
     newest 14 are kept. **This is the undo** (deletes are final and spread everywhere): download one from
     OpenCloud and Import → *Replace* with it. Its covers come from the server.

   Each device drops covers that no series uses any more (deleted series); the server keeps them all.

The token is stored only in `chrome.storage.local` (`secret`), never in synced data, never logged, only
sent over https (plain http is refused except to `localhost`), and never sent to a different server than
the one it was saved for (*Test connection* and *Save* both refuse; enter the new server's token).

### Certificates

Browser extensions cannot bypass certificate errors (there is no "accept the risk" for `fetch`), so a
server with a self-signed certificate fails with a network/TLS error until the browser trusts it. Options
(all on the server side):

- **A proper certificate** for a name you control (e.g. Let's Encrypt with a DNS-01 challenge, which also
  works for a private IP). Trusted everywhere, no per-device setup.
- **Your own CA** (e.g. mkcert) installed on every device (macOS Keychain, `trust anchor` on Linux).
  Firefox needs `security.enterprise_roots.enabled=true` or its own import.
- **Tailscale HTTPS** (`*.ts.net` certificate), with the server configured to use that name.

Reverse proxies such as Traefik serve a self-signed *default* certificate that changes on every restart:
trusting it once is not enough. Wildcard-DNS names like `*.sslip.io` need public DNS; resolvers with
DNS-rebinding protection drop their private answers, even on your LAN.

## How data is kept

- Entries are stored as raw JSON strings (`e:<id>`). `chrome.storage.local` returns objects with
  **alphabetically sorted keys**; strings keep each entry exactly as imported.
- Unknown entry fields survive import → edit → sync → backup.
- Covers referenced by a MangaPin entry but missing from its `imgs` (MangaPin loses some) are kept as
  references and reported in the import dry run. Covers no entry references are not imported.
- `folder` and `type` are numbers (MangaPin's); Settings → Labels names the folders (synced), types are
  fixed (Comic, Novel, Anime).
- `tags` are names — every genre the site lists when you pin, cleaned up: one spelling per tag (case,
  accents and other languages' names of MangaPin's genres count as the same tag), all-caps/all-lowercase
  names capitalised. Inside Shiori tags are only ever names.
- **MangaPin has exactly one way in:** `src/lib/mangapin-import.js` turns a MangaPin export (Import →
  MangaPin export) into Shiori's form — tag numbers become names, MangaPin's `ts` becomes the edit time.
  Nothing else in Shiori reads MangaPin's numbers; tools/shiori-to-mangapin.html is the way back.
- Data from Shiori before 0.3 (`library.json`, snapshots or backups below format 3, browser storage
  without `v: 2`) is refused with a message, never misread. To move a device from 0.2: remove and
  reinstall Shiori there, then let it sync (or import a 0.3 backup).
- Export: `Shiori-DDMMYYYY.json` (local date), a Shiori backup: `{format: "shiori-backup", version,
  library: <same as library.json>, covers: {key: base64}}`. Importing it merges like another device that
  synced (edit times and deletes included), or replaces as below. MangaPin can't read it.

## How merging works (and where it deviates from the original plan)

Per entry id, every field group is a max over a total order, so the merge is commutative,
associative and idempotent (property-tested), and every device converges.

| group | rule |
|---|---|
| `progress` | furthest chapter read **since the last manual correction** |
| `latest` | max by (chap, ts) |
| `next` | max by ts |
| everything else | field by field: the side that edited *that field* last wins |
| `ts` | max |
| tombstone | a delete is final on every device: later reads or edits elsewhere don't undo it; only a *replace* import that has the series restores it |

**One series, one entry.** A series is identified by site + series slug (ignoring the rotating parts some
sites put in their URLs), not by MangaPin's random id. If the same series ends up under two ids — pinned on
two devices before they synced, or imported from a file that has it under another id — both are merged with
the rules above into the one with the smaller id, and the other is deleted. Every device does the same, so
they converge on the same single entry. Importing `xyz` at chapter 22 into a library that has `xyz` at
chapter 12 therefore gives one `xyz` at chapter 22 (and a correction made after the file's reading still wins).

**Clocks.** Every decision above compares device timestamps. A device whose clock is more than 10 min off
the server's (`Date` header) refuses to sync and says so, instead of silently winning or losing every conflict.

Offline edits of *different* fields on two devices (folder on one, tags on the other) both survive; the
same field edited on both: the later edit wins. Tombstones (deleted ids) are
kept forever, ~30 bytes each: without one, a device that still has the series would upload it again.

Two deliberate deviations from "progress by newer progress.ts, rest by newer ts":

1. **Progress = furthest read since your last correction.** Plain "newer progress.ts wins" regresses
   progress in exactly your setup: the desktop that was offline for days reads chapter 35 of a series
   you already read to 50 on the laptop → its *newer* chapter 35 wins. Shiori treats every progress value
   as a read event and takes the highest chapter among events at or after the latest manual correction
   (popup/editor "Set"). So stale reads can't pull you back, a correction wins even when it goes backwards,
   and reads made after a correction on a device that hadn't seen it yet still count. To stay associative it
   keeps the few non-dominated (chapter, time) events in the sidecar (`pf`); with forward-only tracking that
   list is almost always empty.
2. **Rest time ≠ entry.ts.** Release checks and tracking must bump `entry.ts` (MangaPin's invariant
   `ts ≥ nested ts`). With "rest by newer ts", a release check on the desktop would silently overwrite a
   folder/tag edit made on the offline laptop. Shiori keeps the time of the last *user edit* of the rest
   fields in a sidecar (`meta`), next to the entries in its own storage and `library.json`.

Import: choose what the file is — **Shiori backup** (default; also a server snapshot) or **MangaPin
export**; a file of the other kind is refused with a hint. Modes (both show a dry-run summary first; applying re-checks it and asks again if a sync changed
the library meanwhile):

- **merge**: file entries merge in exactly like a sync. Series you deleted (on any device) are *not* re-added.
  For series in both, MangaPin's `ts` counts as the edit time of name/folder/tags (MangaPin also bumps
  `ts` on its own release checks, so a later MangaPin export can win over an older Shiori edit).
- **replace**: the file decides *which series exist*: everything not in the file is deleted on all devices,
  deleted series in the file come back, and the file's order becomes the library's. Shiori syncs first, so
  series that so far only exist on another device are included. Per entry it still merges like sync: it never
  rolls back reading or newer edits.

Covers whose bytes don't match their `local:<bytes>:<md5>.webp` key are kept locally but not synced
(the dry run counts them). If your real export shows many of those, MangaPin derives the key differently
than assumed here — tell me.

### OpenCloud quirk you should know about

OpenCloud 9.2 **ignores `If-None-Match: *`** on PUT (it overwrites with 204 instead of 412). Shiori
therefore reads `library.json` back after creating it and re-merges if another device won the race;
anything still lost in that window is re-uploaded by the next sync because no device ever discards its
local data. `If-Match` works correctly (stale ETag → 412, atomic under parallel writers) and is what
every later write uses.

## Stats

Library → ☰ → Stats. **Reading log**: chapters read today, in the last 7 days, this month and this year,
your reading streak, and a 12-week chart — counted on every device (pinned series, and unpinned ones on
known sites) and synced, so it is your total. Stored as one number per device per day you read
(`library.json` → `days`, ~20 bytes each); there is no per-chapter history. Counting starts with this
version. Below it: totals from your library (chapters read, waiting, folders, sites, tags, scores).
Time is an estimate (2.5 min per chapter), not measured.

Everything on the Stats page is the same on every synced device: the library, the reading log and the
read-before-pin memory (series you read without pinning on a known manga site — never other sites, so a
"chapter-4" page of anything else is not remembered or synced: furthest chapter per series, the newest
100, 30 days) all live in `library.json`. So a series you started unpinned on one PC and pin on the other
starts at the right chapter there.

## Reading indicator on manga pages

On a series or chapter page of a site Shiori knows (or any page of a series you pinned), a small box in
the bottom-right corner shows where you are:

- **pinned:** *Chapter 22 of 40* — with **Continue ch 23** when the next chapter's address is known; on a
  chapter page it shows that chapter as saved;
- **not pinned:** *Read up to ch 7* (from the read-before-pin memory) or *Not started*, with **Pin**
  (pinning starts at the chapter you reached).

× hides it on that page; Settings → *Show where you are on manga pages* turns it off. It lives in a closed
shadow root in the extension's isolated world: the page can't read your progress from it or restyle it,
and its only action, Pin, can only pin the tab it is on.

## Covers

Pinning takes the cover from the page you pin. A series without one — MangaPin lost some, and a few image
servers refuse requests that don't come from their own pages — gets it looked up where the site shows it:
comix's embedded page data, the asura and ezmanga APIs (`series.cover` / `cover`), and for every other site
the page's link-preview image (`og:image`). That happens automatically after release checks (a few series
per run, a failed site asked again after a week; off when release checks are off), or at once with
*Find cover* in the series window. *Upload image…* there takes any image file. A new cover syncs like any edit.

## Moving a series to another site

Sites go down or change domain. In a series' window: *Edit details* → **Move to another site** → paste the
series' address on the new site (series or chapter page). The series gets a new id on the new site with
your progress (as a chapter number — sites sometimes number differently, correct it with *Set* if needed),
folder, tags, score, dates, name and cover; the old id is deleted, so the dead site's chapter list can't
sync back. Reading done on the old site on a device that hadn't synced the move yet is not carried over.

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
  (gitignored) or set `SHIORI_EXPORT=/path/to/export.json`; every fixture-driven test (import keeps every entry byte for byte, backup
  restore, MD5 of every cover key, adapter round trip of every entry, headless import) then runs on
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
src/lib/                 pure modules: mangapin (MangaPin's format + tag table), mangapin-import (the one
                         MangaPin -> Shiori conversion), labels (tag names), merge, library, store, sync, webdav,
                         adapters + sites (site table), tracker, releases, cover, md5, base64
src/popup/  src/app/     UI (DOM built with textContent only — no innerHTML anywhere)
test/                    node:test suites, fixtures (incl. saved live site responses), OpenCloud scripts
tools/shiori-to-mangapin.html  Shiori backup / server snapshot -> MangaPin export (one self-contained page,
                         runs offline in any browser, uploads nothing; not part of the extension)
tools/make-fixture.mjs   synthetic export generator
```
