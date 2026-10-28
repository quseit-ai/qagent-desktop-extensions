# External App Tab

External App Tab is a trusted local Hermes WebUI extension with two modes,
one rail tab. **Workspace files is the default mode**; External URL is the
opt-in alternative (switch it in **Configure**):

- **Workspace files** — browses the profile's trusted workspaces and previews
  local files, HTML first: a workspace switcher in the top-right corner, a
  collapsible file list on the right side, and a sandboxed preview area.
  Entering the panel auto-opens the first HTML file of the current workspace.
  With no saved config it starts on the server's **last workspace**
  (`/api/workspaces` → `last`).
- **External URL** — pins a compatible self-hosted web app (Grafana,
  Vaultwarden, Linkwarden, a personal dashboard) as a tab inside the WebUI via
  an `<iframe>` framing a URL you configure.

### Where the config lives (desktop restart caveat)

Config is stored through `HermesExtensionSettings`, which (like the legacy
fallback key) is **localStorage** — scoped to scheme + host + **port**. The
Electron desktop app binds a random free port on every launch, so a restart
is a new origin and the saved config is empty. That is why the extension
defaults to workspace mode and falls back to the server-persisted last
workspace: after a restart the panel opens ready to preview without a
re-selection. A specific non-last workspace chosen in the panel lasts for the
current app session only; persisting it across desktop restarts would need
either a fixed port or server-side extension settings in core.

The external mode works best for **framable dashboards, status pages, and
local tools** that don't require a cross-origin cookie login; see **Known
Limitations** for the third-party-iframe auth/cookie caveats. The workspace
mode works entirely same-origin against WebUI's own file APIs.

## 中文说明（Chinese） / 中文說明（繁體）

本扩展在左侧导航栏添加一个按钮，点开后是一个全屏面板，**默认使用「工作区文件」模式**，两种模式可通过 Configure 切换：

> 桌面端每次启动使用随机端口，而扩展设置存于 localStorage（按协议+主机+端口隔离），因此重启后本地配置会清空。扩展已默认进入工作区模式，并回退到服务端持久化的「上次工作区」，所以重启后打开面板即可直接预览，无需重新选择。

- **外部 URL 模式**：把一个兼容的自托管 Web 应用（Grafana、个人看板等）
  通过 `<iframe>` 内嵌为标签页。内嵌**外部来源**需要运维通过
  `HERMES_WEBUI_CSP_FRAME_EXTRA="https://你的应用域名"` 放行；同源 / 回环
  地址无需额外配置。
- **工作区文件模式**：顶栏左侧显示应用名称、`工作区` 标签和切换下拉框；
  右侧是可折叠的文件列表；点击文件即可预览。进入面板时会自动打开当前
  工作区的第一个 HTML 文件（优先 `index.html`），并记住上次预览的文件。
  支持的预览格式与 WebUI 原生工作区预览一致：HTML（沙箱 iframe）、图片、
  PDF、音频、视频、Markdown、CSV/TSV 表格、代码/文本（语法高亮）、
  Word（.docx）、Excel（.xlsx/.xls，支持多工作表切换）、
  PowerPoint（.pptx，上一页/下一页翻页）。压缩包、安装包、字体、
  旧版 Office 二进制（.doc/.ppt）等会提示改用「在新标签页中打开」下载。

界面文案跟随 WebUI 的界面语言（简体 / 繁体中文时自动显示中文）；
设置项名称使用中英双语。工作区列表来自 WebUI 的「设置 → 工作区」，
文件读取完全复用核心的同源 API，扩展自身不新增后端。

已知限制：预览的 HTML 中的**相对路径资源**（如 `<link href="style.css">`）
不会加载，这一点与 WebUI 原生工作区预览一致；自包含 HTML 与 CDN 绝对
地址正常。

## What It Does

- Adds a rail button (with the content tabs, above Settings).
- Clicking it opens a full-area overlay with a top bar: the app label, a
  **Workspace** label + switcher next to it (workspace mode only), and a row
  of icon buttons styled like the WebUI's own toolbar buttons — configure,
  open in new tab, refresh, file-list toggle (immediately left of close), and
  close. Hovering an icon shows its tooltip; the framed content sits below.
- **Configure** dialog: pick the mode (**External URL** / **Workspace
  files**); external mode sets a label + an `http(s)` URL. Everything is
  stored in the native Settings → Extensions → External App Tab settings store
  when available, with a legacy localStorage fallback on older core.
- Workspace mode:
  - the top-bar **Workspace** switcher (next to the app label) lists the
    profile's workspaces (`GET /api/workspaces`, same list as
    Settings → Workspaces); the last-used workspace is remembered per
    extension settings
  - the file-list icon toggles the right-side list; directories expand lazily
    (`GET /api/list`), the refresh icon reloads the list and the preview
  - hovering a file or directory row shows its full name (rows truncate long
    names with an ellipsis)
  - clicking a file previews it, matching the native workspace preview's
    format matrix:
    - `.html`/`.htm` render in a sandboxed iframe via
      `GET /api/file/raw?…&inline=1` (same endpoint and server-side CSP sandbox
      as the native preview)
    - images (`png/jpg/jpeg/gif/svg/webp/ico/bmp`) in an `<img>`; PDFs in a
      framed viewer; audio and video with native controls
    - Markdown rendered with core's own `renderMd` (plain-text fallback)
    - CSV/TSV parsed into a scrollable table
    - code/text with Prism syntax highlighting when the page has Prism loaded
    - `.docx` via docx-preview, `.xlsx`/`.xls` via SheetJS (sheet tabs),
      `.pptx` via PptxViewJS on a canvas with previous/next slide controls
    - archives, installers, fonts, databases and legacy Office binaries
      (`.doc`/`.ppt`) show an "open in new tab to download" prompt
  - entering the panel auto-opens the first HTML file of the workspace
    (root-level files first, then a bounded shallow search where `index.html`
    wins); the last-previewed file is remembered and revalidated on reopen
- External mode falls back to a "no app configured" prompt until you set a
  URL.
- Escape or the ✕ closes the overlay; the rail stays accessible.
- **Language**: in-panel text follows the WebUI interface language
  (`<html lang>` / `localStorage['hermes-lang']`) and switches live between
  English and Simplified/Traditional Chinese; settings labels are bilingual.
  Extension bundles cannot register into core's i18n dictionary, so the
  extension ships a small local en/zh table.

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
  dialog, a workspace switcher, a file list, and preview surfaces for the
  supported formats)
- lazy-loads core's vendored preview parsers from the **same origin**
  (`static/vendor/{docx-preview,xlsx,jszip,chart.js,pptxviewjs}/…`) the first
  time a matching file is previewed — same bundles, versions, and paths core
  uses, so no new external origin and no additional network permission
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

Workspace-mode HTML previews run in a stricter frame: `sandbox="allow-scripts
allow-popups allow-popups-to-escape-sandbox"` with **no**
`allow-same-origin`, matching the server-side CSP sandbox core puts on
`/api/file/raw?…&inline=1` responses. The previewed file executes scripts but
lives in an opaque origin — it cannot read WebUI cookies/storage or touch the
parent page. **PDF previews are the one exception**: Chromium renders PDFs
with its built-in viewer, which is refused inside an element-sandboxed frame
(`net::ERR_BLOCKED_BY_CLIENT`), so the PDF frame carries no `sandbox`
attribute — exactly like core's native workspace PDF frame
(`#previewPdfFrame`). PDFs are also requested with `&inline=1`, because
without it `/api/file/raw` falls back to the global security headers whose
`X-Frame-Options: DENY` blocks framing (`net::ERR_BLOCKED_BY_RESPONSE`);
`inline=1` makes the server send its CSP `sandbox` policy instead, which
keeps the document isolated but frameable. Chromium's own viewer parses the
file; no page script from our origin runs in that frame. Dangerous MIME
types (`text/html`, `image/svg+xml`, `application/xhtml+xml`) are served
inline only through this opt-in path;
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
- the file-list icon toggles the right-side list; the refresh icon reloads it
- config (mode + workspace + last file) persists across a reload
- switching the WebUI interface language to 中文 makes the panel, tooltips,
  empty states and config dialog render in Chinese; switching back restores
  English (no reload needed — reopen or re-render the panel)

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
- Rich previews reuse the WebUI's **vendored parser bundles** under
  `static/vendor/` (`docx-preview`, `SheetJS`, `PptxViewJS` + `JSZip`/
  `Chart.js`) and are lazy-loaded on first use, exactly like core. On a core
  build that does not ship those bundles, the corresponding preview fails with
  a "could not render" message; use open-in-new-tab to download instead. No
  new network origin is introduced — the scripts are same-origin.
- Office previews are capped at 20 MB (same as core). `.pptx` navigation is
  slide-by-slide (previous/next); there is no zoom or thumbnails.
- Markdown is rendered with core's `renderMd` when available (it is on
  standard builds); otherwise the extension falls back to plain text.
- The first-HTML auto-open search is bounded (root level + up to 3 levels
  deep, max 24 directory listings); in sprawling workspaces it may not find
  an HTML file that exists deeper.
- One external app at a time (single configured URL); workspace mode previews
  one file at a time.
