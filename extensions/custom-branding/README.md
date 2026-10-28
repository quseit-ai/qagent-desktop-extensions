# Custom Branding

Custom Branding is a trusted local Desktop extension that lets you
white-label the app chrome with **your own logo and favicon**. The Hermes
titlebar mark, the empty-state hero logo, and the browser-tab favicon are all
swapped for images of your choice.

## 中文说明

本扩展用你自己的标志和网站图标替换 Desktop 的品牌标识：标题栏标志、
空状态页大图标，以及浏览器标签页图标都会换成你上传的图片。

- **使用方法**：点击标题栏左侧的标志打开选择器。
- **标志（Logo）**：替换标题栏和空状态页的标志，建议尺寸不超过 256px。
- **网站图标（Favicon）**：替换浏览器标签页图标，建议尺寸不超过 64px。
- **按钮**：「上传… / 更换…」「移除」；仅支持 PNG / JPEG / WebP 图片。
- 图片在浏览器内压缩后存入 `localStorage`，不会上传到任何服务器；点击「移除」
  即可恢复 Hermes 默认图标。
- 界面文案跟随 Desktop 的界面语言（简体 / 繁体中文时自动显示中文）。

## What It Does

- Click the titlebar logo (`.app-titlebar-icon`) to open a small picker:
  - **Logo** — upload an image; it replaces the inline titlebar SVG mark and the
    large empty-state hero logo (`.empty-logo`).
  - **Favicon** — upload an image; it replaces the browser-tab icon (the
    `<link rel="icon">` / `shortcut icon` / `apple-touch-icon` nodes in `<head>`).
- Each image is **downscaled and stored locally** as a data-URL in
  `localStorage` (logo ≤ 256px, favicon ≤ 64px), so it stays small and survives
  reloads.
- Re-applies after the UI re-renders (transcript rebuilds, panel toggles,
  reload) via a `MutationObserver`, so your branding persists.
- Restores the original Hermes logo / favicon when you remove a custom image.

## Credit

This extension was **rebuilt as a client-side extension from closed core PR
[nesquena/hermes-webui#3307](https://github.com/nesquena/hermes-webui/pull/3307)**
("Add custom logo and favicon uploads") by **[@gavinssr](https://github.com/gavinssr)**.
The original PR shipped a server-side upload endpoint plus `config.yaml`
persistence; that scope was a core-curation call (instance branding is optional,
opt-in, and self-contained — an extension-model fit, not core). Because
extensions cannot add core endpoints, this is a **client-side rebuild**:
localStorage data-URLs applied by DOM swaps rather than a server round-trip. The
validation/downscale approach preserves @gavinssr's original design intent
(only ever apply a validated raster image, sized down aggressively).

## Current Shape

```text
Desktop page
  -> manifest-bundled extension assets
  -> /extensions/assets/custom-branding.js + .css
  -> swaps .app-titlebar-icon SVG + .empty-logo SVG for an <img> when a logo is set
  -> swaps the <head> favicon <link> nodes for a managed <link> when a favicon is set
  -> localStorage: hermes-ext-custom-branding-logo, hermes-ext-custom-branding-favicon
```

This extension is `static-ui` / manifest-bundle only. It does not add backend
routes, start a sidecar, access external networks, or use native host APIs.
Image processing happens entirely in the browser (`FileReader` + `<canvas>`
downscale); nothing is uploaded anywhere.

## Capabilities

- `manifest-bundle`

## Install For Local Testing

```bash
cd /path/to/hermes-webui
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-extensions/extensions/custom-branding \
  HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json ./start.sh
```

Then click the small Hermes logo in the top-left titlebar and upload a logo
and/or favicon.

## Controls

Also exposed on `window.HermesCustomBrandingExtension`:

- `.getLogo()` / `.getFavicon()` — current data-URL (or empty)
- `.setLogo(dataUrl)` / `.setFavicon(dataUrl)` — set a `data:image/...` value
- `.clearLogo()` / `.clearFavicon()` — remove it
- `.refresh()` — re-apply to the current DOM

## Disable And Uninstall

Restart Desktop without `HERMES_WEBUI_EXTENSION_DIR` /
`HERMES_WEBUI_EXTENSION_MANIFEST`, or remove the `extensions/custom-branding/`
directory. Your images live under the `hermes-ext-custom-branding-logo` and
`hermes-ext-custom-branding-favicon` localStorage keys.

## Trust And Permissions

This is trusted local code. Current disclosed behavior:

- creates extension-owned DOM (an `<img>` inside the logo containers, a managed
  favicon `<link>`, and a picker popover) and mutates core views (swaps the
  titlebar / empty-state logo and neutralizes the core favicon `<link>` nodes)
- reads the uploaded image file locally (`FileReader`) and downscales it via a
  `<canvas>`; the result is a small data-URL
- reads and writes `localStorage` under exactly two keys:
  `hermes-ext-custom-branding-logo` and `hermes-ext-custom-branding-favicon`
- does not call Desktop HTTP APIs (`webui_api.read/write` are empty)
- does not navigate the Desktop (`webui_navigation: false`)
- does not access cookies
- does not contact loopback or external network services (`network_external:
  false` — the image never leaves the browser)
- does not use arbitrary filesystem or native host APIs (the file picker is the
  standard browser `<input type=file>`)

### Security note (SVG-XSS)

Uploads are restricted to raster **PNG / JPEG / WebP** and are **rasterized via
`<canvas>`** before storage (`canvas.toDataURL` emits `image/png` or
`image/jpeg` only). A stored value therefore can never carry raw SVG markup, so
the SVG-XSS surface an `<svg>` favicon/logo would open is avoided by design.
Only validated `data:image/(png|jpeg|webp);base64,...` values are ever applied.

## Compatibility

- manifest-bundled extension assets + same-origin serving under `/extensions/`
- titlebar logo container `.app-titlebar-icon`, empty-state logo container
  `.empty-logo`, and the `<head>` favicon `<link>` nodes (the integration
  contract; a core rename would need an update)

## Verification

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/test-extension-validator.mjs
node scripts/generate-registry.mjs --out dist/registry.json
node --check extensions/custom-branding/assets/custom-branding.js
python3 -m json.tool extensions/custom-branding/extension.json
python3 -m json.tool extensions/custom-branding/manifest.json
```

Manual verification:

- clicking the titlebar logo opens the picker; uploading a logo replaces the
  titlebar mark and the empty-state hero logo
- uploading a favicon swaps the browser-tab icon
- both persist across a reload and re-apply after a re-render
- removing a logo / favicon restores the Hermes default
- a non-raster or oversized file is rejected with a message, not applied

## Known Limitations

- Branding is per-browser (`localStorage`), not synced across devices.
- Relies on `.app-titlebar-icon` / `.empty-logo` / the `<head>` favicon links; a
  core rename would need an update.
- Uploads are rasterized to PNG/JPEG (no live SVG) and downscaled (logo ≤ 256px,
  favicon ≤ 64px) to keep localStorage small and avoid SVG-XSS.
- Swapping the `apple-touch-icon` / favicon `<link>` changes the **browser-tab**
  icon only. An **installed PWA / iOS home-screen** icon is read from the web app
  manifest at install time, so it is not affected by this extension.
