# Throwaway OpenCloud for Shiori WebDAV tests

OpenCloud **9.2.0 (rolling)**, image `opencloudeu/opencloud-rolling:latest` = `9.2.0`, linux/amd64
(revision 8b4139136232a5feac39c24be9a7a03d46c67bfc, built 2026-11-17), running natively in this container.

## Quick start

```sh
D=test/opencloud
$D/start.sh            # idempotent: start (or no-op if healthy), ensure user + app token, write $D/env
$D/stop.sh             # stop (keeps data/config/env)
RESET=1 $D/start.sh    # wipe and start fresh (new user + new token)
OC_TLS=1 $D/start.sh   # same, but HTTPS with OpenCloud's self-signed cert (restarts if running in HTTP mode)
$D/verify.sh [folder]  # re-run every check below against ./env (default folder ShioriVerify, deleted afterwards)
```

`$D/env` (HTTP mode, current):

```
SHIORI_DAV_URL=http://127.0.0.1:9200/remote.php/webdav/
SHIORI_DAV_USER=shiori
SHIORI_DAV_TOKEN="<six lowercase words separated by spaces>"
```

* **The app token contains spaces.** It is written double-quoted so that `set -a; . env`, `dotenv`
  and `node --env-file=env` all yield the bare token. A hand-rolled `split('=')` parser must strip the quotes.
* In TLS mode the file also has `SHIORI_DAV_INSECURE=1` and `SHIORI_DAV_CA=$D/data/proxy/server.crt`.
* Local requests must bypass the egress proxy: `curl --noproxy '*'`. Node's built-in `fetch` ignores
  `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1`, and even then `NO_PROXY` already contains 127.0.0.1/localhost.
  Both cases were checked with a Node 22 fetch client (PROPFIND 207, MKCOL 201, PUT 201, If-Match 204/412, GET, DELETE).

Layout: `bin/opencloud` (static binary from the image), `config/opencloud.yaml` (from `opencloud init`),
`data/` (OC_BASE_DATA_PATH), `run/` (pid, `server.log`, `admin-token`, mode), `env`.
Admin: `admin` / password `admin` (password login is disabled, see below). The admin app token is in `run/admin-token`.
User `shiori` has password `ShioriPass123!`, which is only used to create the account.

## How it was set up (and what was skipped)

* **Docker was not used.** I did not try `dockerd`. I went straight to the fallback: anonymous token from
  `auth.docker.io`, then the OCI index, the amd64 manifest and the blobs from `registry-1.docker.io` with curl
  (sha256-verified). The last layer holds only `/usr/bin/opencloud`, a static-pie Go binary (141 MB) that runs as-is here.
  `start.sh` downloads this pinned layer again (`sha256:c62127ef…d8d3`) if `bin/opencloud` is missing.
  That path was tested.
* `opencloud init --config-path config --insecure true --admin-password admin`
* Runtime env used by `start.sh` in HTTP mode:

| var | value | why |
|---|---|---|
| `OC_CONFIG_DIR` / `OC_BASE_DATA_PATH` | `$D/config` / `$D/data` | keep everything in the scratch dir |
| `OC_URL` | `http://127.0.0.1:9200` | public URL |
| `PROXY_TLS` | `false` | plain HTTP on the proxy (port 9200) |
| `PROXY_HTTP_ADDR` | `127.0.0.1:9200` | loopback only |
| `OC_EXCLUDE_RUN_SERVICES` | `idp` | **required with http**: built-in IDP dies with `invalid iss value, URL must start with https://` (fatal, kills the whole runtime). Not needed for Basic/app-token auth. |
| `OC_INSECURE` | `true` | internal self-signed TLS between services |
| `OC_LOG_LEVEL` | `warn` | |

  **Not needed:** `OC_ADD_RUN_SERVICES=auth-app` and `PROXY_ENABLE_APP_AUTH`. In 9.2.0, `auth-app` is in the
  default service list (`opencloud list` shows it) and app-token Basic auth works with no extra settings.
  This matches "works out of the box" on your production install.
  **Not set on purpose:** `PROXY_ENABLE_BASIC_AUTH`. It is off by default, as in production, so a **password** gets 401.
* TLS mode (`OC_TLS=1`): `OC_URL=https://localhost:9200`, default `PROXY_TLS` (true), IDP enabled.

## Findings

### 1. Base URL and WebDAV roots
Base `http://127.0.0.1:9200`. With the app token, all of these return **207 for the same personal space** (same `oc:id`, same root `getetag`):

```
/remote.php/webdav/                  207  <d:href>/remote.php/webdav/  <oc:id>58180a08-…!58180a08-…
/webdav/                             207  <d:href>/webdav/             (same oc:id)
/dav/files/shiori/                   207  <d:href>/dav/files/shiori/   (same oc:id)
/remote.php/dav/files/shiori/        207  <d:href>/remote.php/dav/files/shiori/ (same oc:id)
/dav/spaces/<personal-spaceid>/      207
/dav/files/admin/   (as shiori)      404  Sabre\DAV\Exception\NotFound
```
They are equivalent for data. The difference is that **`<d:href>` values repeat the prefix the request was made with**,
so a client must strip whatever root it used, not a hard-coded one. `/dav/files/<user>/` needs the
*authenticated* user's username; another name gives 404. `SHIORI_DAV_URL` uses `/remote.php/webdav/`.

### 2. Users and app tokens
* Second user created through the Graph API, authenticated as admin with an **admin app token**:
  `POST /graph/v1.0/users {"onPremisesSamAccountName":"shiori","displayName":…,"mail":…,"passwordProfile":{"password":…}}` returned `201`.
  The personal space is created on the user's first authenticated request.
* Token via CLI (needs the running server; same `OC_CONFIG_DIR`):
  `opencloud auth-app create --user-name shiori --expiration 8760h` prints `App token created for shiori\n token: <six words>`.
  The default expiry is 72h. `start.sh` uses 8760h and reuses the token from `env` while it still authenticates.
* Token via HTTP: `POST /auth-app/tokens?expiry=24h` with Basic `admin:<app token>` returned
  `200 {"token":"<redacted>","expiration_date":"…","created_date":"…","label":"Generated via API"}`.
  App-token Basic auth is enough to mint more tokens.
* Auth matrix (default config, as in production):
  ```
  app token  PROPFIND /remote.php/webdav/ -> 207
  password   PROPFIND /remote.php/webdav/ -> 401
  no auth    PROPFIND /remote.php/webdav/ -> 401
    Www-Authenticate: Bearer realm="127.0.0.1:9200", charset="UTF-8"
    Www-Authenticate: Basic realm="127.0.0.1:9200", charset="UTF-8"
  app token of shiori sent with user "admin" -> 401
  ```
  With `PROXY_ENABLE_BASIC_AUTH=true` (tested in a probe run) the password gives 207 and app tokens still work.
  The proxy then tries an LDAP bind first and logs an `error` for every app-token request. Leave it off.

### 3. MKCOL
```
MKCOL /Shiori (new)            -> 201   (no ETag header in the response)
MKCOL /Shiori (exists)         -> 405   <s:message>The resource you tried to create already exists</s:message>
MKCOL /Shiori/covers (new)     -> 201
MKCOL /Shiori/covers (exists)  -> 405
MKCOL on an existing *file*    -> 405
MKCOL /NoParent/child          -> 409   Sabre\DAV\Exception\Conflict
```

### 4. PUT with `If-None-Match: *` — **IGNORED**
```
absent  -> HTTP/1.1 201 Created   Etag: "64531b9c1bba0d0fa795f3d53c092cdc"   Oc-Etag: (same)
present -> HTTP/1.1 204 No Content Etag: "b92bad0f6db897464afb9e7e3e3ed634"  ← file OVERWRITTEN, no 412
content after 2nd If-None-Match:* PUT: {"v":2}
```
The result is the same on `/remote.php/webdav`, `/dav/files/shiori`, `/remote.php/dav/files/shiori` and `/dav/spaces/<id>`.
`If-None-Match: "<current etag>"` on PUT is also ignored (204). **OpenCloud 9.2.0 never returns 412 for If-None-Match on PUT.**
A test that expects 412 on a conflicting first write will fail against this server. Your production server probably behaves the same if it runs a similar version.

### 5. ETag format
Strong and double-quoted, a 32-hex string: `Etag: "af4c36299ef2358819c32b164b974eba"`. Never `W/`.
An identical `Oc-Etag` header is sent too. The PUT response ETag equals the following GET/HEAD `ETag` and the PROPFIND `getetag`:
```
PUT ETag="af4c…eba"  GET ETag="af4c…eba"  PROPFIND getetag="af4c…eba"  equal=yes
```
The ETag is stable across repeated GETs. It **changes on every PUT, even with identical content**. Parent folder
ETags change synchronously when a child changes, so a PROPFIND Depth 0 on `/Shiori/` works as a cheap change check.
HEAD works on files and collections and returns the ETag.

### 6. PUT with `If-Match`
```
If-Match: <stale>                      -> 412 (Content-Length: 0, file unchanged)
If-Match: <current, quoted>            -> 204, new ETag in the response
If-Match: <current, unquoted>          -> 412   (exact string compare: send it verbatim, with the quotes)
If-Match: W/<current>                  -> 412
If-Match: *  (file exists)             -> 412   (!! RFC says it should succeed)
If-Match: <anything> on a missing file -> 412, nothing created
PUT into a missing parent folder       -> 409
6 parallel PUTs with the same If-Match -> 412 412 412 412 204 412   (atomic: exactly one winner)
```

### 7. PROPFIND Depth 1 on /Shiori/covers/
```
HTTP/1.1 207 Multi-Status
Content-Type: application/xml; charset=utf-8
Dav: 1, 3, extended-mkcol
<d:multistatus xmlns:s="http://sabredav.org/ns" xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
<d:response><d:href>/remote.php/webdav/Shiori/covers/</d:href><d:propstat><d:prop><d:getetag>"4b26…4010"</d:getetag><d:getlastmodified>Mon, 23 Nov 2026 10:45:36 GMT</d:getlastmodified><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:getcontentlength></d:getcontentlength></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>
<d:response><d:href>/remote.php/webdav/Shiori/covers/abc123.png</d:href><d:propstat><d:prop><d:getetag>"8053…98a7"</d:getetag><d:getcontentlength>3</d:getcontentlength><d:getlastmodified>…</d:getlastmodified><d:resourcetype></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/remote.php/webdav/Shiori/covers/my%20cover%20%C3%A9%23+%25.jpg</d:href>…</d:response></d:multistatus>
```
* Hrefs are absolute paths with no scheme or host, starting with the request prefix. The collection itself comes first, with a trailing slash.
* Encoding: space `%20`, UTF-8 `%C3%A9`, `#` `%23`, `%` `%25`, but **`+` stays literal**. Use `decodeURIComponent`, not
  `URLSearchParams`/form decoding, which would turn `+` into a space.
* Namespace prefix is `d:` bound to `DAV:`. Parse by namespace, not by prefix. Error bodies use `xmlns:d="DAV"` (no colon, Sabre-style bug).
* For a collection, `getcontentlength` comes back in a separate `404` propstat. Folders carry `oc:size` in allprop instead.
* With no body (allprop) you also get `oc:id`, `oc:fileid`, `oc:permissions`, `getcontenttype`, `oc:checksums` (SHA1/MD5/ADLER32) and more.
* With no Depth header the server treats it as Depth 1. `Depth: infinity` returns 400. PROPFIND on a missing path returns 404.

### 8. Missing resources
`HEAD` missing file → 404. `GET` missing → 404. `HEAD` under a missing parent → 404. `DELETE` missing → 404.
**DELETE ignores If-Match**: `DELETE` with `If-Match: "deadbeef"` returns 204 and the file is gone.
DELETE of a non-empty folder returns 204 (recursive). Deleted items go to the trash bin (`PROPFIND /remote.php/dav/spaces/trash-bin/<spaceid>` lists them).

### 9. `Origin: chrome-extension://abc`
There is no CSRF or Origin rejection. Every method succeeds with that header (PROPFIND 207, MKCOL 201, GET 200, PUT 204, DELETE 204).
CORS: by default only `OC_URL` is an allowed origin. For `chrome-extension://abc` the server returns **no
`Access-Control-Allow-Origin`**, and the preflight comes back as a bare `204` with only `Vary`. This does not matter for an MV3
extension that has `host_permissions` for the server, because CORS is not enforced there. In a CORS-mode fetch it would fail.
Probe with `OC_CORS_ALLOW_ORIGINS="http://127.0.0.1:9200,chrome-extension://abc"`: the preflight for PUT/PROPFIND/MKCOL with
`authorization,content-type,depth,if-match,if-none-match` passes. Responses still expose only
`Location, Tus-*`. **`ETag` is not in `Access-Control-Expose-Headers`**, so a CORS-bound page could not read it
(`OC_CORS_EXPOSE_HEADERS` exists for that). Curl note: rs/cors only accepts a *sorted* `Access-Control-Request-Headers`
list, which browsers send. An unsorted hand-written list makes the preflight look like it was rejected.

### 10. TLS
* Default (`PROXY_TLS` unset/true): HTTPS on :9200 with a cert generated on first start at `data/proxy/server.crt`:
  `subject=O = Acme Corp, CN = OpenCloud`, self-signed, 1 year, `SAN: DNS:localhost, IP Address:127.0.0.1`.
  `curl` without a CA exits 60. Plain `http://` to the TLS port gives `HTTP/1.0 400 Bad Request — Client sent an HTTP request to an HTTPS server.`
  Node: `NODE_EXTRA_CA_CERTS=$SHIORI_DAV_CA` works (verified: PROPFIND 207). Without it you get `DEPTH_ZERO_SELF_SIGNED_CERT`.
  You can also pass `{ca}` to an `https.Agent`/undici `Agent`. Prefer the CA over `rejectUnauthorized:false`.
* Plain HTTP works with `PROXY_TLS=false` + `OC_URL=http://…` + **`OC_EXCLUDE_RUN_SERVICES=idp`**. This is the default mode of `start.sh`.
  WebDAV, Graph, auth-app and the CLI all work. Only browser OIDC login (the web UI) is unavailable.

## Behaviour table (OpenCloud 9.2.0)

| Request | Result |
|---|---|
| MKCOL new / exists / parent missing | 201 / **405** / 409 |
| PUT new file, no condition | 201 + `ETag` |
| PUT new file, `If-None-Match: *` | 201 + `ETag` |
| PUT existing file, `If-None-Match: *` | **204, overwrites. Header ignored, no 412** |
| PUT existing, `If-Match: <current quoted etag>` | 204 + new `ETag` |
| PUT existing, `If-Match: <stale etag>` | **412**, unchanged |
| PUT existing, `If-Match: *` / unquoted / `W/` | 412 (!) |
| PUT missing file, `If-Match: <any>` | 412, not created |
| PUT, parent folder missing | 409 |
| GET/HEAD existing | 200, `ETag: "<32 hex>"` (strong, quoted) = PUT response ETag = PROPFIND getetag |
| GET/HEAD/PROPFIND/DELETE missing | 404 |
| DELETE with stale `If-Match` | **204, deleted. Header ignored** |
| PROPFIND Depth 0/1 | 207. No Depth = 1. `infinity` = 400 |
| any method with `Origin: chrome-extension://…` | works. No ACAO header (default CORS) |
| Basic user:app-token / user:password / none | 207 / 401 / 401 |

## Surprises / caveats
1. **`If-None-Match: *` is a no-op on PUT.** You cannot get create-only semantics from this server. If the extension
   relies on a 412 for "someone else created it first", that branch never fires on OpenCloud 9.2.0, and the second writer
   silently overwrites. Tests that assert 412 here will fail against the real server. Make them assert "either 412,
   or success, and then the If-Match flow detects divergence", or skip them for OpenCloud.
2. `If-Match: *` returns 412 even when the file exists. Use the real ETag.
3. DELETE ignores `If-Match`.
4. Every PUT changes the ETag, including no-op rewrites.
5. Hrefs echo the request prefix, and `+` is not percent-encoded in hrefs.
6. The app token has spaces in it (6 words). Base64 of `user:word word …` is correct. Do not trim or URL-encode it.
7. HTTP mode requires dropping the IDP service. Otherwise the whole runtime exits on start.
8. PROPFIND Depth 1 on the **root** of the personal space lists a virtual `Shares/` collection with the fixed ETag `"DECAFC00FEE"`.
   It is the shares mount point, and it appears even when nothing is shared. It does not appear under `/Shiori/`.
9. Startup takes about 4 s to `status.php` 200. `start.sh` also waits until an app-token PROPFIND succeeds.
   The process is a single `opencloud server` (setsid, pid in `run/opencloud.pid`, about 180 MB RSS).

## Raw output of the last `verify.sh` run
(Folder `ShioriVerify`. A first run against `/Shiori` gave identical results. Both folders were deleted afterwards, so the space starts empty.)

```

### 0. auth: app token vs password vs none
app token  PROPFIND /remote.php/webdav/ -> 207
password   PROPFIND /remote.php/webdav/ -> 401
no auth    PROPFIND /remote.php/webdav/ -> 401
HTTP/1.1 401 Unauthorized
Www-Authenticate: Bearer realm="127.0.0.1:9200", charset="UTF-8"
Www-Authenticate: Basic realm="127.0.0.1:9200", charset="UTF-8"

### 1. WebDAV roots (oc:id + getetag of the root must match)
/remote.php/webdav/                  207  <d:href>/remote.php/webdav/  <oc:id>58180a08-5dfe-4798-9781-442b8bb871b0!58180a08-5dfe-4798-9781-442b8bb871b0
/webdav/                             207  <d:href>/webdav/  <oc:id>58180a08-5dfe-4798-9781-442b8bb871b0!58180a08-5dfe-4798-9781-442b8bb871b0
/dav/files/shiori/                   207  <d:href>/dav/files/shiori/  <oc:id>58180a08-5dfe-4798-9781-442b8bb871b0!58180a08-5dfe-4798-9781-442b8bb871b0
/remote.php/dav/files/shiori/        207  <d:href>/remote.php/dav/files/shiori/  <oc:id>58180a08-5dfe-4798-9781-442b8bb871b0!58180a08-5dfe-4798-9781-442b8bb871b0
/dav/files/admin/                    404    
/dav/spaces/<spaceid>/               207  (spaceid=58180a08-5dfe-4798-9781-442b8bb871b0)

### 3. MKCOL
MKCOL /ShioriVerify (new)            -> 201
MKCOL /ShioriVerify (exists)         -> 405
MKCOL /ShioriVerify/covers (new)     -> 201
MKCOL /ShioriVerify/covers (exists)  -> 405
MKCOL /NoParent/child      -> 409
HTTP/1.1 405 Method Not Allowed
  body message: The resource you tried to create already exists

### 4. PUT If-None-Match: * (absent, then present)
HTTP/1.1 201 Created
Content-Length: 0
Etag: "3ba4b99159c31b9e085d77b2864d5810"
Oc-Etag: "3ba4b99159c31b9e085d77b2864d5810"
Vary: Origin
HTTP/1.1 204 No Content
Etag: "f9ce75eadd5ee69a53830beae073d333"
Oc-Etag: "f9ce75eadd5ee69a53830beae073d333"
Vary: Origin
content after 2nd If-None-Match:* PUT: {"v":2}   (if {"v":2} -> header was IGNORED)

### 5. GET ETag vs PUT ETag
PUT ETag="af4c36299ef2358819c32b164b974eba"  GET ETag="af4c36299ef2358819c32b164b974eba"  PROPFIND getetag="af4c36299ef2358819c32b164b974eba"  equal=yes
HTTP/1.1 200 OK
Content-Length: 7
Content-Type: application/json; charset=UTF-8
Etag: "af4c36299ef2358819c32b164b974eba"
Oc-Etag: "af4c36299ef2358819c32b164b974eba"
Vary: Origin

### 6. PUT If-Match
If-Match stale ("3ba4b99159c31b9e085d77b2864d5810")   -> 412
If-Match current ("af4c36299ef2358819c32b164b974eba") -> 204
If-Match unquoted current     -> 412
If-Match W/current            -> 412
If-Match: * (file exists)     -> 412
If-Match any on missing file  -> 412  then GET -> 404
PUT into missing parent       -> 409
content now: {"v":4}
race: 6 parallel PUTs with the same If-Match -> 412 412 412 412 204 412 

### 7. PROPFIND Depth 1 on /ShioriVerify/covers/
HTTP/1.1 207 Multi-Status
Access-Control-Expose-Headers: Tus-Resumable, Tus-Version, Tus-Extension
Content-Length: 1329
Content-Type: application/xml; charset=utf-8
Dav: 1, 3, extended-mkcol
Vary: Origin, Prefer

<d:multistatus xmlns:s="http://sabredav.org/ns" xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
<d:response><d:href>/remote.php/webdav/ShioriVerify/covers/</d:href><d:propstat><d:prop><d:getetag>"4b2675ee2691cb77171bb5c2f4c34010"</d:getetag><d:getlastmodified>Mon, 23 Nov 2026 10:45:36 GMT</d:getlastmodified><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:getcontentlength></d:getcontentlength></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>
<d:response><d:href>/remote.php/webdav/ShioriVerify/covers/abc123.png</d:href><d:propstat><d:prop><d:getetag>"8053b7602d68cf6837ce5fa54d1598a7"</d:getetag><d:getcontentlength>3</d:getcontentlength><d:getlastmodified>Mon, 23 Nov 2026 10:45:36 GMT</d:getlastmodified><d:resourcetype></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/remote.php/webdav/ShioriVerify/covers/my%20cover%20%C3%A9%23+%25.jpg</d:href><d:propstat><d:prop><d:getetag>"6f7822223029758f00523e4e66293b05"</d:getetag><d:getcontentlength>1</d:getcontentlength><d:getlastmodified>Mon, 23 Nov 2026 10:45:36 GMT</d:getlastmodified><d:resourcetype></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>

Depth: infinity -> 400   no Depth header -> 3 hrefs (=Depth 1)
PROPFIND missing -> 404

### 8. HEAD/GET/DELETE on missing
HEAD missing file   -> 404
GET missing file    -> 404
HEAD missing parent -> 404
DELETE with stale If-Match -> 204  then HEAD -> 404  (204+404 = If-Match IGNORED on DELETE)
DELETE missing      -> 404

### 9. Origin: chrome-extension://abc
PROPFIND -> 207
MKCOL    -> 201
GET      -> 200
PUT      -> 204
DELETE   -> 204
-- response headers for GET with Origin: chrome-extension://abc
HTTP/1.1 200 OK
Content-Length: 12
Content-Type: application/json; charset=UTF-8
Etag: "f9f3e20d9a47e032322c8fe2f9e48864"
Oc-Etag: "f9f3e20d9a47e032322c8fe2f9e48864"
Vary: Origin
-- preflight OPTIONS from chrome-extension://abc
HTTP/1.1 204 No Content
Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers
-- preflight OPTIONS from OC_URL origin (http://127.0.0.1:9200)
HTTP/1.1 204 No Content
Access-Control-Allow-Headers: authorization,content-type,if-match
Access-Control-Allow-Methods: PUT
Access-Control-Allow-Origin: http://127.0.0.1:9200
Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers

cleanup: DELETE /ShioriVerify -> 204
```
