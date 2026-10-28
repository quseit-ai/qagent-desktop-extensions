# External App Tab

External App Tab is a trusted local Hermes WebUI extension with two modes,
one rail tab:

- **External URL** — pins a compatible self-hosted web app (Grafana,
  Vaultwarden, Linkwarden, a personal dashboard) as a tab inside the WebUI via
  an `<iframe>` framing a URL you configure.
- **Workspace files** — browses the profile's trusted workspaces and previews
  local files, HTML first: a workspace switcher in the top-right corner, a
  collapsible file list on the right side, and a sandboxed preview area.
  Entering the panel auto-opens the first HTML file of the current workspace.

The external mode works best for **framable dashboards, status pages, and
local tools** that don't require a cross-origin cookie login; see **Known
Limitations** for the third-party-iframe auth/cookie caveats. The workspace
mode works entirely same-origin against WebUI's own file APIs.

## What It Does

- Adds a rail button (with the content tabs, above Settings).
- Clicking it opens a full-area overlay with a top bar (title, mode controls,
  **Configure**, **Open ↗**, **Close**) and the framed content below.
- **Configure** dialog: pick the mode (**External URL** / **Workspace
  files**); external mode sets a label + an `http(s)` URL. Everything is
  stored in the native Settings → Extensions → External App Tab settings store
  when available, with a legacy localStorage fallback on older core.
- Workspace mode:
  - the top-bar switcher lists the profile's workspaces (`GET /api/workspaces`,
    same list as Settings → Workspaces); the last-used workspace is remembered
    per extension settings
  - the **Files** button toggles the right-side file list; directories expand
    lazily (`GET /api/list`), **Refresh** reloads the list and the preview
  - clicking a file previews it: `.html`/`.htm` render in a sandboxed iframe
    via `GET /api/file/raw?…&inline=1` (the same endpoint and server-side CSP
    sandbox the native workspace preview uses); images, PDFs, and text show
    inline; other binaries download
  - entering the panel auto-opens the first HTML file of the workspace
    (root-level files first, then a bounded shallow search where `index.html`
    wins); the last-previewed file is remembered and revalidated on reopen
- External mode falls back to a "no app configured" prompt until you set a
  URL.
- Escape or the ✕ closes the overlay; the rail stays accessible.

## ⚠️ CSP dependency (external mode only — read this)

The WebUI's Content-Security-Policy only allows framing **same-origin**
content by default. To frame an **external** origin, the operator must allow
it via the core knob (added in `nesquena/hermes-webui` **PR #5091**):

```bash
export HERMES_WEBUI_CSP_FRAME_EXTRA="https://your-app.example.com"
```

- A **same-origin** or **loopback-reverse-proxied** URL works with **no** core
  change.
- If the configured URL is blocked by CSP, the browser refuses to load the
  frame (it stays blank). The overlay shows a hint with the exact
  `HERMES_WEBUI_CSP_FRAME_EXTRA` value to set.
- On a WebUI build **without** PR #5091, only same-origin URLs can be framed.
- **Workspace mode needs no CSP change** — it frames WebUI's own
  `/api/file/raw` endpoint (same-origin).

## Current Shape

```text
Hermes WebUI page
  -> manifest-bundled extension assets
  -> /extensions/assets/external-app-tab.js + .css
  -> rail button -> full-area overlay
       external mode:  <iframe src="<your URL>">
       workspace mode: workspace switcher (/api/workspaces)
                       + right file list (/api/list)
                       + sandboxed <iframe src="/api/file/raw?...&inline=1">
  -> Settings → Extensions → External App Tab settings: { mode, url, label, workspace, lastFile }
  -> legacy fallback: localStorage hermes-ext-external-app
```

Workspace mode's file access is **session-anchored** like the native
workspace panel: it mints one throwaway preview session per workspace via
`POST /api/session/new {workspace}` — core's `new_session` is in-memory only
(no disk write until a first message, no agent start, no sidebar entry) — and
uses that `session_id` for `/api/list`, `/api/file`, and `/api/file/raw`. All
path validation (traversal, symlink escape, trusted workspace roots, TOCTOU
anchored opens) stays in core (`api/workspace.py`); the extension adds none of
its own. Preview sessions are evicted by server restarts or the in-memory LRU;
every session-anchored call self-heals a 404 by re-minting the session once.

This extension is `static-ui` / manifest-bundle only. It does not add backend
routes, start a sidecar, or use native host APIs. External mode sets an
`<iframe src>` directly; workspace mode makes same-origin WebUI API calls.

## Capabilities

- `manifest-bundle`

## Install For Local Testing

```bash
cd /path/to/hermes-webui
# allow your app's origin to be framed (external mode, external origins only):
HERMES_WEBUI_CSP_FRAME_EXTRA="https://your-app.example.com" \
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-extensions/extensions/external-app-tab \
HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json \
./start.sh
```

Click the new rail button, **Configure**, pick a mode (enter the URL for
external mode), and Save. For workspace mode, pick a workspace in the
top-bar switcher and click files in the right-side list.

## Controls

Also on `window.HermesExternalAppTabExtension`:

- `.getConfig()` → `{ url, label, mode, workspace, lastFile }`
- `.setConfig(url, label)` — set the external-mode URL/label (rejects
  non-http(s) URLs)
- `.open()` / `.close()` — toggle the overlay

## Disable And Uninstall

Restart Hermes WebUI without `HERMES_WEBUI_EXTENSION_DIR` /
`HERMES_WEBUI_EXTENSION_MANIFEST`, or remove the `extensions/external-app-tab/`
directory. Config lives in the native Settings → Extensions store on supported
core builds; older builds use the legacy `hermes-ext-external-app` localStorage
key. Workspace-mode preview sessions are in-memory only and disappear with the
server process.

## Trust And Permissions

This is trusted local code. Current disclosed behavior:

- creates extension-owned DOM (a rail button, a full-area overlay, a config
  dialog, a workspace switcher, a file list)
- external mode embeds a **user-configured external URL** in an `<iframe>`
  (`permissions.network_external: true`) — the URL is whatever the operator
  sets and is subject to the page CSP
- workspace mode calls same-origin WebUI HTTP APIs (`permissions.webui_api`):
  reads `GET /api/workspaces`, `GET /api/list`, `GET /api/file`,
  `GET /api/file/raw`, and creates preview sessions with
  `POST /api/session/new` (in-memory sessions bound to trusted workspace
  paths; it does **not** chat, does **not** touch other sessions, and does
  **not** change the profile's last-used workspace — switching here affects
  only this panel)
- reads/writes `mode`, `url`, `label`, `workspace`, and `lastFile` through
  the native `HermesExtensionSettings` store
  (`permissions.storage.owned: true`), with a legacy fallback to the single
  `hermes-ext-external-app` localStorage key on older core builds
- does NOT access cookies, loopback sidecars, the filesystem, or native hosts
  beyond what the WebUI APIs above already enforce server-side

External-mode apps run in their own `<iframe>` with an explicit `sandbox`
allow-list: `allow-scripts allow-forms allow-popups
allow-popups-to-escape-sandbox allow-same-origin allow-downloads`. This lets a
real web app function (run its scripts, submit forms, open links/downloads)
while still being a sandboxed frame. **Honest tradeoff:** a functional app
generally needs both `allow-scripts` and `allow-same-origin`, and that pairing
relaxes the sandbox's origin barrier — so for a **same-origin** target the
frame is effectively trusted browser content, not strongly isolated. Treat
any app you embed as trusted: you opt in per-origin by allow-listing it via
`HERMES_WEBUI_CSP_FRAME_EXTRA`, and cross-origin targets remain bounded by the
same-origin policy.

Workspace-mode previews run in a stricter frame: `sandbox="allow-scripts
allow-popups allow-popups-to-escape-sandbox"` with **no**
`allow-same-origin`, matching the server-side CSP sandbox core puts on
`/api/file/raw?…&inline=1` responses. The previewed file executes scripts but
lives in an opaque origin — it cannot read WebUI cookies/storage or touch the
parent page. Dangerous MIME types (`text/html`, `image/svg+xml`,
`application/xhtml+xml`) are served inline only through this opt-in path;
core injects `<base target="_blank">` so links escape to a new tab. All
user-supplied strings (label, URL) are escaped where rendered; file names are
rendered via `textContent`, never as HTML.

## Compatibility

- manifest-bundled extension assets + same-origin serving under `/extensions/`
- native Settings → Extensions fields via `settings_schema` /
  `HermesExtensionSettings`, with localStorage fallback on older core builds
- the left rail (`.rail`) to host the button
- workspace mode: core APIs `/api/workspaces`, `/api/session/new`,
  `/api/list`, `/api/file`, `/api/file/raw?…&inline=1` (the inline HTML
  preview path) — all present in current core
- external mode: the core `HERMES_WEBUI_CSP_FRAME_EXTRA` knob (PR #5091) for
  external origins

## Verification

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/generate-registry.mjs --out dist/registry.json
node --check extensions/external-app-tab/assets/external-app-tab.js
python3 -m json.tool extensions/external-app-tab/extension.json
python3 -m json.tool extensions/external-app-tab/manifest.json
```

Manual verification:

- Settings → Extensions → External App Tab exposes **Mode**, **App URL**,
  **Rail label**, **Workspace path**, **Last previewed file**
- the rail button appears; clicking it opens the overlay
- external mode: with no URL set, the empty-state prompt + Configure appear;
  configuring a same-origin URL frames it immediately; an external URL frames
  when `HERMES_WEBUI_CSP_FRAME_EXTRA` allows that origin, otherwise the frame
  is blank and the CSP hint is shown
- workspace mode: the switcher lists the profile's workspaces; switching
  reloads the file list; entering the panel auto-opens the first HTML file
  (or `index.html` when present within the search bounds)
- clicking an HTML file renders it in the sandboxed frame; images/PDF/text
  show inline; other files download; Open ↗ opens the current file raw in a
  new tab; Close / Escape closes the overlay
- the Files button toggles the right-side list; Refresh reloads it
- config (mode + workspace + last file) persists across a reload

## Known Limitations

- External origins require the operator to allow them via
  `HERMES_WEBUI_CSP_FRAME_EXTRA` (PR #5091) — a deliberate security boundary.
  This is **necessary but not sufficient**: it answers "may Hermes embed this
  origin?", not "will this app work correctly embedded?"
- Some sites send `X-Frame-Options: DENY` / their own `frame-ancestors` and
  refuse to be embedded by anyone; those can't be framed (open them in a new
  tab instead). This is the remote site's choice, not a WebUI limitation.
- **Authenticated apps may fail inside the iframe even when the origin is
  allow-listed.** An embedded app runs in a third-party (cross-origin) context,
  so its session cookies may not be sent from inside the iframe — third-party
  cookie blocking, `SameSite`, `Secure`/HTTPS requirements, and the target app's
  own frame/cookie policy all apply. A common failure mode: login succeeds
  (the app creates a server-side session) but the next in-frame request returns
  401 because the browser withheld the session cookie in the embedded context.
  This is the normal browser security boundary — the extension can't fix it with
  frontend JS.
- **If login succeeds but the embedded app stays logged out / returns 401**, use
  **Open in new tab**, or configure the target app for iframe use. Stable
  embedded login usually requires a same-origin reverse proxy, or HTTPS plus
  appropriate cookie settings (`SameSite=None; Secure`) and a framing policy that
  permits embedding.
- Workspace-mode HTML preview has the **same relative-asset limitation as the
  native workspace preview**: a previewed `page.html` is served from
  `/api/file/raw`, so relative references (`<link href="style.css">`,
  `<img src="img/logo.png">`) do not resolve and will 404. Self-contained HTML
  (inline CSS/JS) and absolute/CDN URLs render fully. Multi-file site preview
  would need core-side relative-URL rewriting — deliberately out of scope here.
- The first-HTML auto-open search is bounded (root level + up to 3 levels
  deep, max 24 directory listings); in sprawling workspaces it may not find
  an HTML file that exists deeper.
- One external app at a time (single configured URL); workspace mode previews
  one file at a time.
