(() => {
  'use strict';

  // ── External App Tab extension for Hermes WebUI ──────────────────────────
  // Two modes, one rail tab:
  //   * external  — pin a compatible self-hosted web app (Grafana, a personal
  //     dashboard) as a tab inside the WebUI via an <iframe> pointing at a
  //     user-configured URL.
  //   * workspace — browse the WebUI's trusted workspaces and preview local
  //     files, HTML first. Top bar switches workspaces, a collapsible right
  //     panel lists workspace files, and clicking a file previews it.
  //
  // IMPORTANT — CSP dependency (external mode only):
  //   The WebUI's Content-Security-Policy only allows framing same-origin
  //   content by default. To frame an EXTERNAL origin, the operator must allow
  //   it via the core knob (nesquena/hermes-webui PR #5091):
  //       export HERMES_WEBUI_CSP_FRAME_EXTRA="https://your-app.example.com"
  //   A same-origin or loopback-reverse-proxied URL works without any core
  //   change. Workspace mode is always same-origin (it frames WebUI's own
  //   /api/file/raw endpoint) and needs no CSP change.
  //
  // Workspace mode relies on existing core APIs — no sidecar, no core change:
  //   GET  /api/workspaces              -> {workspaces: [{path, name}], last}
  //   POST /api/session/new {workspace} -> {session: {session_id, ...}}
  //                                        (in-memory only: no disk write, no
  //                                        agent start, no sidebar entry — see
  //                                        api/models.py new_session). The file
  //                                        APIs below are session-anchored, so
  //                                        the extension mints one throwaway
  //                                        preview session per workspace.
  //   GET  /api/list?session_id&path    -> {entries: [{name, path, type, ...}]}
  //   GET  /api/file?session_id&path    -> {content, ...} (text read; used as
  //                                        an existence probe for the remembered
  //                                        last-previewed file)
  //   GET  /api/file/raw?session_id&path[&inline=1]
  //                                    -> raw bytes; &inline=1 serves text/html
  //                                       inline under a server-side CSP sandbox
  //                                       exactly like the native workspace
  //                                       preview iframe (static/workspace.js).
  // Preview sessions can be evicted (server restart / in-memory LRU); every
  // session-anchored call self-heals a 404 by re-minting the session once.
  //
  // Pure DOM-injection + HermesExtensionSettings (with legacy localStorage fallback).
  // No backend of its own; workspace-mode fetches are same-origin WebUI API
  // calls (cookies + the page's global fetch CSRF patch apply automatically).

  const EXT = 'external-app-tab';
  if (window.__hermesExternalAppTabLoaded) return;
  window.__hermesExternalAppTabLoaded = true;

  const CFG_KEY = 'hermes-ext-external-app';   // legacy localStorage key (pre-settings_schema): { url, label, mode, workspace, lastFile }
  const RAIL_BTN_ID = 'hwxExtAppRailBtn';
  const OVERLAY_ID = 'hwxExtAppOverlay';

  // Same sandbox allow-list core puts on /api/file/raw?...&inline=1 responses
  // (CSP `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox`).
  // Deliberately WITHOUT allow-same-origin: the previewed file runs in an
  // opaque origin and cannot read the parent page's cookies or storage.
  const WS_IFRAME_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';
  const HTML_FILE_RE = /\.html?$/i;

  let overlayOpen = false;

  // ── config ───────────────────────────────────────────────────────────────
  // Workspace mode is the default: the panel exists to preview workspace
  // files, and the plain external-URL mode is the opt-in side.
  //
  // Persistence caveat: core's extension settings (and the legacy key) live in
  // localStorage, which is scoped to scheme+host+PORT. The Electron desktop app
  // binds a random free port on every launch (electron/main.js findFreePort),
  // so a restart means a new origin and an empty store. That is why the panel
  // must open in a sensible state with no saved config: workspace mode by
  // default, plus the server-persisted "last workspace" from /api/workspaces.
  const DEFAULT_MODE = 'workspace';

  function normalizeMode(v) {
    return v === 'external' ? 'external' : DEFAULT_MODE;
  }

  function legacyLoadCfg() {
    try {
      const raw = localStorage.getItem(CFG_KEY);
      if (!raw) return { url: '', label: 'App', mode: DEFAULT_MODE, workspace: '', lastFile: '' };
      const c = JSON.parse(raw) || {};
      return {
        url: typeof c.url === 'string' ? c.url : '',
        label: c.label || 'App',
        mode: normalizeMode(c.mode),
        workspace: typeof c.workspace === 'string' ? c.workspace : '',
        lastFile: typeof c.lastFile === 'string' ? c.lastFile : '',
      };
    } catch (_) { return { url: '', label: 'App', mode: DEFAULT_MODE, workspace: '', lastFile: '' }; }
  }

  function extSettings() {
    try {
      const api = window.HermesExtensionSettings;
      if (api && typeof api.settingsForExtension === 'function') {
        const s = api.settingsForExtension('external-app-tab');
        if (s && s.supported) return s;
      }
    } catch (_) {}
    return null;
  }

  function loadCfg() {
    const s = extSettings();
    if (s) {
      const legacy = legacyLoadCfg();
      let url = s.get('url');
      let label = s.get('label');
      let mode = s.get('mode');
      let workspace = s.get('workspace');
      let lastFile = s.get('lastFile');
      // One-time soft migration for users who configured the extension before
      // settings_schema existed. Keep the legacy key as a harmless fallback for
      // older core; writes go through HermesExtensionSettings once supported.
      if (!url && validUrl(legacy.url)) {
        try { s.set('url', legacy.url); } catch (_) {}
        url = legacy.url;
      }
      if ((!label || label === 'App') && legacy.label && legacy.label !== 'App') {
        try { s.set('label', legacy.label); } catch (_) {}
        label = legacy.label;
      }
      // A store without a saved mode (fresh profile / schema added later)
      // falls back to the legacy value, then to the workspace default. Same
      // for workspace/lastFile, which the mirrored legacy key may still hold
      // when the settings store was not primed at save time.
      if (!mode) {
        mode = legacy.mode;
        try { s.set('mode', mode); } catch (_) {}
      }
      if (!workspace && legacy.workspace) {
        workspace = legacy.workspace;
        try { s.set('workspace', workspace); } catch (_) {}
      }
      if (!lastFile && legacy.lastFile) {
        lastFile = legacy.lastFile;
        try { s.set('lastFile', lastFile); } catch (_) {}
      }
      return {
        url: typeof url === 'string' ? url : '',
        label: (typeof label === 'string' && label) || 'App',
        mode: normalizeMode(mode),
        workspace: typeof workspace === 'string' ? workspace : '',
        lastFile: typeof lastFile === 'string' ? lastFile : '',
      };
    }
    return legacyLoadCfg();
  }

  function saveCfg(cfg) {
    const next = {
      url: cfg.url || '',
      label: cfg.label || 'App',
      mode: normalizeMode(cfg.mode),
      workspace: cfg.workspace || '',
      lastFile: cfg.lastFile || '',
    };
    const s = extSettings();
    if (s) {
      try {
        s.set('url', next.url); s.set('label', next.label); s.set('mode', next.mode);
        s.set('workspace', next.workspace); s.set('lastFile', next.lastFile);
      } catch (_) {}
    }
    // Always mirror to the legacy key too: the sanctioned settings store is
    // primed asynchronously from /api/extensions/status, so a save that lands
    // before it is ready would otherwise be dropped silently.
    try { localStorage.setItem(CFG_KEY, JSON.stringify(next)); } catch (_) {}
  }

  // Only http(s) absolute URLs are accepted (an iframe src must be http(s)).
  function validUrl(s) {
    if (typeof s !== 'string' || !s) return false;
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (_) { return false; }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── i18n (en / zh) ───────────────────────────────────────────────────────
  // Core exposes its active locale via <html lang> and localStorage
  // 'hermes-lang' ('en', 'zh', 'zh-Hant', …). Extension bundles cannot
  // register into core's dictionary, so keep a small local one and follow the
  // page language. Read live (no cache) so a locale switch is picked up on
  // the next render without a reload.
  const STR = {
    en: {
      externalApp: 'External app',
      workspace: 'Workspace',
      configure: 'Configure',
      openNewTab: 'Open in new tab',
      refresh: 'Refresh',
      toggleFiles: 'Toggle file list',
      close: 'Close',
      files: 'Files',
      loading: 'Loading…',
      loadingFiles: 'Loading files…',
      noApp: 'No app configured yet.',
      noAppHint: 'Set a URL to embed a compatible self-hosted web app as a tab.',
      configureEllipsis: 'Configure…',
      noWorkspaces: 'No workspaces',
      noWorkspacesHint: 'No workspaces are configured for this profile yet.',
      wsListFailed: 'Workspace list unavailable: {0}',
      listFailed: 'Could not list workspace: {0}',
      emptyWorkspace: 'This workspace is empty.',
      selectFile: 'Select a file to preview.',
      selectFileHint: 'HTML files render in a sandboxed frame; images, PDFs and text show inline.',
      noHtml: 'No HTML files found in this workspace.',
      previewFailed: 'Preview failed: {0}',
      previewFailedPlain: 'Could not render this preview.',
      unsupportedFile: 'This file type has no in-app preview. Use the open-in-new-tab button to view or download it.',
      tooLargeFile: 'File is too large to preview (max 20 MB).',
      emptySheet: 'Empty sheet',
      prevSlide: 'Previous slide',
      nextSlide: 'Next slide',
      dirOpenFailed: 'Could not open {0}: {1}',
      preview: 'Preview',
      configTitle: 'External app tab',
      mode: 'Mode',
      modeExternal: 'External URL',
      modeWorkspace: 'Workspace files',
      labelField: 'Label',
      urlField: 'URL (http/https)',
      labelPlaceholder: 'App',
      cspNote: 'To frame an external origin, the operator must allow it via ' +
        '<code>HERMES_WEBUI_CSP_FRAME_EXTRA</code>. Same-origin / loopback URLs work without it.',
      wsNote: 'Workspace mode browses the profile\'s trusted workspaces ' +
        '(Settings → Workspaces) and previews local files in a sandboxed frame — same-origin, no CSP change needed. ' +
        'Pick the workspace from the switcher inside the panel.',
      invalidUrl: 'Enter a valid http(s) URL (or leave blank to clear).',
      cancel: 'Cancel',
      save: 'Save',
      cspHint: 'If this stays blank, the page may be blocked by the Desktop ' +
        'Content-Security-Policy. Allow it (operator) with ',
    },
    zh: {
      externalApp: '外部应用',
      workspace: '工作区',
      configure: '配置',
      openNewTab: '在新标签页中打开',
      refresh: '刷新',
      toggleFiles: '显示/隐藏文件列表',
      close: '关闭',
      files: '文件',
      loading: '加载中…',
      loadingFiles: '正在加载文件…',
      noApp: '尚未配置应用。',
      noAppHint: '设置一个 URL，把兼容的自托管 Web 应用作为标签页内嵌进来。',
      configureEllipsis: '去配置…',
      noWorkspaces: '暂无工作区',
      noWorkspacesHint: '当前配置文件还没有配置任何工作区。',
      wsListFailed: '无法获取工作区列表：{0}',
      listFailed: '无法列出工作区：{0}',
      emptyWorkspace: '该工作区为空。',
      selectFile: '选择一个文件进行预览。',
      selectFileHint: 'HTML 文件会渲染在沙箱 iframe 中；图片、PDF 和文本会内联显示。',
      noHtml: '该工作区中没有找到 HTML 文件。',
      previewFailed: '预览失败：{0}',
      previewFailedPlain: '无法渲染该预览。',
      unsupportedFile: '该文件类型暂不支持应用内预览，请用「在新标签页中打开」查看或下载。',
      tooLargeFile: '文件过大，无法预览（上限 20 MB）。',
      emptySheet: '空工作表',
      prevSlide: '上一页',
      nextSlide: '下一页',
      dirOpenFailed: '无法打开 {0}：{1}',
      preview: '预览',
      configTitle: '外部应用标签页',
      mode: '模式',
      modeExternal: '外部 URL',
      modeWorkspace: '工作区文件',
      labelField: '标签名称',
      urlField: 'URL（http/https）',
      labelPlaceholder: '应用',
      cspNote: '如需内嵌外部来源，运维需通过 ' +
        '<code>HERMES_WEBUI_CSP_FRAME_EXTRA</code> 放行该来源。同源 / 回环地址无需额外配置。',
      wsNote: '工作区模式会浏览当前配置文件的可信工作区（设置 → 工作区），并在沙箱 iframe 中预览本地文件——' +
        '同源访问，无需修改 CSP。在工作区面板内顶部的下拉框切换工作区。',
      invalidUrl: '请输入有效的 http(s) URL（或留空以清除）。',
      cancel: '取消',
      save: '保存',
      cspHint: '如果此处一直空白，页面可能被 Desktop 的内容安全策略（CSP）拦截。' +
        '请运维配置 ',
    },
  };

  function isZh() {
    let v = '';
    try { v = String(document.documentElement.lang || ''); } catch (_) {}
    if (!/^zh/i.test(v)) {
      try { v = String(localStorage.getItem('hermes-lang') || ''); } catch (_) {}
    }
    return /^zh/i.test(v);
  }

  function t(key) {
    const table = isZh() ? STR.zh : STR.en;
    return (table && table[key]) || STR.en[key] || key;
  }

  // {0}, {1}, … substitution for messages carrying runtime values.
  function tf(key, ...args) {
    let out = t(key);
    args.forEach((a, i) => { out = out.split('{' + i + '}').join(String(a)); });
    return out;
  }

  // ── same-origin WebUI API helper (subpath-mount safe, like core's api()) ──
  async function apiFetch(relPath, opts) {
    opts = opts || {};
    const url = new URL(relPath.replace(/^\//, ''), document.baseURI || location.href);
    const res = await fetch(url.href, {
      credentials: 'include',
      method: opts.method || 'GET',
      headers: Object.assign(
        opts.body ? { 'Content-Type': 'application/json' } : {},
        opts.headers || {}
      ),
      body: opts.body,
    });
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || ('HTTP ' + res.status);
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ── workspace preview state ──────────────────────────────────────────────
  const WS = {
    workspaces: [],        // [{path, name}] from /api/workspaces
    current: '',           // active workspace path
    sessions: new Map(),   // workspace path -> preview session_id
    expanded: new Set(),   // expanded dir rel-paths (reset on workspace switch)
    currentFile: '',       // rel path currently previewed
    treeVisible: true,
    gen: 0,                // increments on every workspace switch / tree reload;
                           // stale async continuations bail when their gen is old
    previewGen: 0,         // same guard for preview requests (rapid file clicks)
  };

  async function ensurePreviewSession(wsPath) {
    if (WS.sessions.has(wsPath)) return WS.sessions.get(wsPath);
    const data = await apiFetch('api/session/new', {
      method: 'POST',
      body: JSON.stringify({ workspace: wsPath }),
    });
    const sid = data && data.session && data.session.session_id;
    if (!sid) throw new Error('/api/session/new returned no session_id');
    WS.sessions.set(wsPath, String(sid));
    return String(sid);
  }

  // Session-anchored call with 404 self-heal: an evicted/restarted preview
  // session 404s; drop it, re-mint once, retry.
  async function callSessionApi(wsPath, buildPath) {
    for (let attempt = 0; ; attempt++) {
      const sid = await ensurePreviewSession(wsPath);
      let out;
      try {
        out = await apiFetch(buildPath(sid));
      } catch (e) {
        if (e.status === 404 && attempt === 0) { WS.sessions.delete(wsPath); continue; }
        throw e;
      }
      return out;
    }
  }

  function listDir(wsPath, rel) {
    return callSessionApi(wsPath, (sid) =>
      'api/list?session_id=' + encodeURIComponent(sid) + '&path=' + encodeURIComponent(rel || '.'));
  }

  // Text-read probe used to validate a remembered lastFile before framing it.
  async function fileReadable(wsPath, rel) {
    try {
      await callSessionApi(wsPath, (sid) =>
        'api/file?session_id=' + encodeURIComponent(sid) + '&path=' + encodeURIComponent(rel));
      return true;
    } catch (_) { return false; }
  }

  function rawFileUrl(sid, rel, opts) {
    opts = opts || {};
    const p = new URLSearchParams();
    p.set('session_id', sid);
    p.set('path', rel);
    if (opts.inline) p.set('inline', '1');
    if (opts.bust) p.set('_t', String(Date.now()));
    return new URL('api/file/raw?' + p.toString(), document.baseURI || location.href).href;
  }

  function joinWsPath(dir, name) {
    return (!dir || dir === '.') ? name : dir + '/' + name;
  }

  // ── rail button ──────────────────────────────────────────────────────────
  function railIcon() {
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/>' +
      '<path d="M15 21V9"/></svg>';
  }

  function ensureRailButton() {
    if (document.getElementById(RAIL_BTN_ID)) return document.getElementById(RAIL_BTN_ID);
    const rail = document.querySelector('.rail');
    if (!rail) return null;
    const btn = document.createElement('button');
    btn.id = RAIL_BTN_ID;
    btn.type = 'button';
    btn.className = 'rail-btn nav-tab has-tooltip hwx-extapp-rail';
    const cfg = loadCfg();
    btn.dataset.tooltip = cfg.label || 'App';
    btn.setAttribute('aria-label', cfg.label || t('externalApp'));
    btn.innerHTML = railIcon();
    btn.addEventListener('click', (ev) => { ev.preventDefault(); toggleOverlay(); });
    // Insert just before the rail spacer (so it sits with the content tabs,
    // above settings), or append if there's no spacer.
    const spacer = rail.querySelector('.rail-spacer');
    if (spacer) rail.insertBefore(btn, spacer);
    else rail.appendChild(btn);
    return btn;
  }

  // ── overlay panel ────────────────────────────────────────────────────────
  // Icon set mirrors WebUI's own panel-icon-btn glyphs (14px, stroke 2, no
  // fill) so the extension bar reads like core toolbar buttons.
  const ICONS = {
    config: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
    open: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
    refresh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
    files: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>',
    close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  };

  // cssName is separate from the icon key so the files toggle (files-btn)
  // never collides with the file panel's .hwx-extapp-files rule.
  function iconBtn(cssName, label, iconName) {
    return '<button type="button" class="hwx-extapp-iconbtn hwx-extapp-' + cssName + '"' +
      ' title="' + escapeHtml(label) + '" aria-label="' + escapeHtml(label) + '">' +
      ICONS[iconName || cssName] + '</button>';
  }

  function buildOverlay() {
    let ov = document.getElementById(OVERLAY_ID);
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = OVERLAY_ID;
    ov.className = 'hwx-extapp-overlay';
    ov.style.display = 'none';
    // Bar layout: [app label][workspace label + switcher] …… [icon buttons].
    // Files sits immediately left of Close; every action is an icon button
    // matching core's .panel-icon-btn look.
    ov.innerHTML =
      '<div class="hwx-extapp-bar">' +
        '<span class="hwx-extapp-title"></span>' +
        '<label class="hwx-extapp-wsgroup">' +
          '<span class="hwx-extapp-wslabel"></span>' +
          '<select class="hwx-extapp-ws-select"></select>' +
        '</label>' +
        '<span class="hwx-extapp-spacer"></span>' +
        iconBtn('config', t('configure')) +
        iconBtn('open', t('openNewTab')) +
        iconBtn('refresh', t('refresh')) +
        iconBtn('files-btn', t('toggleFiles'), 'files') +
        iconBtn('close', t('close')) +
      '</div>' +
      '<div class="hwx-extapp-body"></div>';
    document.body.appendChild(ov);
    ov.querySelector('.hwx-extapp-close').addEventListener('click', () => closeOverlay());
    ov.querySelector('.hwx-extapp-config').addEventListener('click', () => openConfig());
    ov.querySelector('.hwx-extapp-refresh').addEventListener('click', () => reloadTree({ bustPreview: true }));
    ov.querySelector('.hwx-extapp-files-btn').addEventListener('click', () => {
      WS.treeVisible = !WS.treeVisible;
      syncTreeVisible();
    });
    ov.querySelector('.hwx-extapp-open').addEventListener('click', () => {
      const cfg = loadCfg();
      if (cfg.mode === 'workspace') {
        if (WS.current && WS.currentFile) {
          ensurePreviewSession(WS.current).then((sid) => {
            // inline=1 keeps HTML renderable in the new tab instead of
            // force-downloading it (core serves dangerous MIME types inline
            // only behind this opt-in, under a CSP sandbox).
            window.open(rawFileUrl(sid, WS.currentFile, { inline: isHtmlFile(WS.currentFile) }),
              '_blank', 'noopener');
          }).catch(() => {});
          return;
        }
        return;
      }
      if (validUrl(cfg.url)) window.open(cfg.url, '_blank', 'noopener');
    });
    return ov;
  }

  function renderOverlayContent() {
    const ov = buildOverlay();
    const cfg = loadCfg();
    const isWs = cfg.mode === 'workspace';
    // Workspace-only controls are hidden in external mode.
    ov.querySelector('.hwx-extapp-wsgroup').hidden = !isWs;
    // In workspace mode the workspace switcher is the only top-bar title, so
    // the app label would only duplicate the tab name.
    ov.querySelector('.hwx-extapp-title').hidden = isWs;
    ov.querySelector('.hwx-extapp-refresh').hidden = !isWs;
    ov.querySelector('.hwx-extapp-files-btn').hidden = !isWs;
    // Localized bar text is stamped per render so a locale switch applies
    // without rebuilding the overlay.
    const wsLabel = ov.querySelector('.hwx-extapp-wslabel');
    if (wsLabel) wsLabel.textContent = t('workspace');
    const wsSelEl = ov.querySelector('.hwx-extapp-ws-select');
    if (wsSelEl) wsSelEl.setAttribute('aria-label', t('workspace'));
    if (isWs) {
      renderWorkspaceContent(ov);
      return;
    }
    ov.querySelector('.hwx-extapp-title').textContent = cfg.label || t('externalApp');
    const body = ov.querySelector('.hwx-extapp-body');
    body.innerHTML = '';
    if (!validUrl(cfg.url)) {
      const empty = document.createElement('div');
      empty.className = 'hwx-extapp-empty';
      empty.innerHTML =
        '<p>' + escapeHtml(t('noApp')) + '</p>' +
        '<p class="hwx-extapp-muted">' + escapeHtml(t('noAppHint')) + '</p>' +
        '<button type="button" class="hwx-extapp-btn hwx-extapp-config-cta">' +
          escapeHtml(t('configureEllipsis')) + '</button>';
      empty.querySelector('.hwx-extapp-config-cta').addEventListener('click', () => openConfig());
      body.appendChild(empty);
      return;
    }
    const frame = document.createElement('iframe');
    frame.className = 'hwx-extapp-iframe';
    frame.src = cfg.url;
    frame.setAttribute('title', cfg.label || t('externalApp'));
    // Sandbox the embedded app with an explicit, documented allow-list so it can
    // function (scripts/forms/popups) while staying constrained (Frank, PR #25:
    // the previous comment claimed "sandboxed" but never set a sandbox attr).
    // Tradeoff: a real web app generally needs allow-scripts + allow-same-origin
    // to work; for a SAME-ORIGIN target that pairing relaxes the origin barrier,
    // so the README is explicit that an embedded app is trusted browser content
    // once the operator allow-lists its origin via HERMES_WEBUI_CSP_FRAME_EXTRA.
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-downloads');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    // A CSP frame-src block surfaces as a blank frame; show a hint underneath
    // that the operator may need HERMES_WEBUI_CSP_FRAME_EXTRA.
    const hint = document.createElement('div');
    hint.className = 'hwx-extapp-cspnote';
    hint.innerHTML = escapeHtml(t('cspHint')) +
      '<code>HERMES_WEBUI_CSP_FRAME_EXTRA="' + escapeHtml(originOf(cfg.url)) + '"</code>.';
    body.appendChild(frame);
    body.appendChild(hint);
  }

  function originOf(u) { try { return new URL(u).origin; } catch (_) { return u; } }

  // ── workspace mode: bar + file tree + preview ────────────────────────────
  function renderWorkspaceContent(ov) {
    const body = ov.querySelector('.hwx-extapp-body');
    body.innerHTML = '';

    // The switcher lives in the top bar (the app label is hidden in workspace
    // mode). Repopulate it per render; its change listener is attached once
    // (marked via dataset).
    const wsSel = ov.querySelector('.hwx-extapp-ws-select');
    if (!wsSel.dataset.bound) {
      wsSel.dataset.bound = '1';
      wsSel.addEventListener('change', () => {
        if (wsSel.value && wsSel.value !== WS.current) switchWorkspace(wsSel.value, { restore: false });
      });
    }
    wsSel.innerHTML = '';
    wsSel.appendChild(new Option(t('loading'), ''));

    // Body: preview area (left) + collapsible file tree (right).
    const wrap = document.createElement('div');
    wrap.className = 'hwx-extapp-ws-body';
    const preview = document.createElement('div');
    preview.className = 'hwx-extapp-preview';
    const empty = document.createElement('div');
    empty.className = 'hwx-extapp-empty hwx-extapp-preview-empty';
    empty.innerHTML = '<p>' + escapeHtml(t('selectFile')) + '</p>' +
      '<p class="hwx-extapp-muted">' + escapeHtml(t('selectFileHint')) + '</p>';
    preview.appendChild(empty);
    const aside = document.createElement('aside');
    aside.className = 'hwx-extapp-files';
    aside.innerHTML =
      '<div class="hwx-extapp-files-head">' + escapeHtml(t('files')) + '</div>' +
      '<div class="hwx-extapp-tree" role="tree"></div>' +
      '<div class="hwx-extapp-files-status" hidden></div>';
    wrap.appendChild(preview);
    wrap.appendChild(aside);
    body.appendChild(wrap);
    syncTreeVisible();

    aside.querySelector('.hwx-extapp-tree').addEventListener('click', (ev) => {
      const row = ev.target.closest('.hwx-extapp-tree-row');
      if (!row) return;
      if (row.classList.contains('is-dir')) toggleTreeDir(row);
      else previewFile(row.dataset.rel || '');
    });

    loadWorkspacesIntoSelect(wsSel)
      .catch((e) => wsStatus(tf('wsListFailed', e.message), true));
  }

  function syncTreeVisible() {
    const aside = document.querySelector('#' + OVERLAY_ID + ' .hwx-extapp-ws-body .hwx-extapp-files');
    const btn = document.querySelector('#' + OVERLAY_ID + ' .hwx-extapp-files-btn');
    if (aside) aside.classList.toggle('collapsed', !WS.treeVisible);
    if (btn) btn.classList.toggle('active', WS.treeVisible);
  }

  function wsStatus(msg, isError) {
    const el = document.querySelector('#' + OVERLAY_ID + ' .hwx-extapp-files-status');
    if (!el) return;
    el.hidden = !msg;
    el.textContent = msg || '';
    el.classList.toggle('is-error', !!isError);
  }

  async function loadWorkspacesIntoSelect(wsSel) {
    const data = await apiFetch('api/workspaces');
    const list = (data && data.workspaces) || [];
    const last = (data && data.last) || '';
    WS.workspaces = list;
    wsSel.innerHTML = '';
    if (!list.length) {
      wsSel.appendChild(new Option(t('noWorkspaces'), ''));
      wsSel.disabled = true;
      wsStatus(t('noWorkspacesHint'), true);
      return;
    }
    wsSel.disabled = false;
    for (const w of list) {
      const opt = new Option(w.name || w.path, w.path || '');
      opt.title = w.path || '';
      wsSel.appendChild(opt);
    }
    const cfg = loadCfg();
    let initial = cfg.workspace && list.some((w) => w.path === cfg.workspace)
      ? cfg.workspace
      : (last && list.some((w) => w.path === last) ? last : list[0].path);
    wsSel.value = initial;
    await switchWorkspace(initial, { restore: !!cfg.lastFile && cfg.workspace === initial });
  }

  async function switchWorkspace(wsPath, opts) {
    opts = opts || {};
    const gen = ++WS.gen;
    WS.previewGen++; // invalidate any in-flight preview from the old workspace
    WS.current = wsPath;
    WS.expanded = new Set();
    WS.currentFile = '';
    const cfg = loadCfg();
    saveCfg({ ...cfg, workspace: wsPath, lastFile: '' });
    // The active workspace name is carried by the switcher (and its selected
    // option) in the top bar.
    setPreviewEmpty();
    await loadTreeRoot(gen);
    if (!overlayOpen || gen !== WS.gen) return;
    if (opts.restore && cfg.lastFile) {
      if (await fileReadable(wsPath, cfg.lastFile)) {
        if (!overlayOpen || gen !== WS.gen) return;
        await previewFile(cfg.lastFile);
        return;
      }
      // Remembered file is gone — fall through to the first-HTML search.
    }
    await autoOpenFirstHtml(wsPath, gen);
  }

  async function loadTreeRoot(gen) {
    const tree = document.querySelector('#' + OVERLAY_ID + ' .hwx-extapp-tree');
    if (!tree) return;
    tree.innerHTML = '';
    wsStatus(t('loadingFiles'), false);
    let entries;
    try {
      entries = (await listDir(WS.current, '.')).entries || [];
    } catch (e) {
      if (gen !== WS.gen) return;
      wsStatus(tf('listFailed', e.message), true);
      return;
    }
    if (gen !== WS.gen) return;
    wsStatus('', false);
    appendTreeEntries(tree, entries, 0);
    if (!entries.length) wsStatus(t('emptyWorkspace'), false);
  }

  async function reloadTree(opts) {
    opts = opts || {};
    const gen = ++WS.gen;
    WS.expanded = new Set();
    await loadTreeRoot(gen);
    if (opts.bustPreview && WS.currentFile && gen === WS.gen) {
      await previewFile(WS.currentFile, { bust: true });
    }
  }

  // Rows are built with DOM APIs (textContent) — server-supplied names/paths
  // are never injected as HTML.
  function appendTreeEntries(container, entries, depth) {
    for (const en of entries) {
      if (en.type === 'symlink' && en.target_outside_workspace) continue; // display-only escape link: skip
      const rel = en.path || joinWsPath('.', en.name);
      const row = document.createElement('div');
      row.className = 'hwx-extapp-tree-row' + ((en.type === 'dir' || en.is_dir) ? ' is-dir' : '');
      row.dataset.rel = rel;
      row.dataset.depth = String(depth);
      row.setAttribute('role', 'treeitem');
      // Full name on hover: the row truncates long names with an ellipsis, so
      // the native title tooltip is the only place the whole name is visible.
      row.title = en.name || rel;
      if (en.type === 'dir' || en.is_dir) row.setAttribute('aria-expanded', 'false');
      const chev = document.createElement('span');
      chev.className = 'hwx-extapp-tree-chev';
      chev.setAttribute('aria-hidden', 'true');
      chev.textContent = '▸';
      const name = document.createElement('span');
      name.className = 'hwx-extapp-tree-name';
      name.textContent = en.name || rel;
      row.appendChild(chev);
      row.appendChild(name);
      container.appendChild(row);
      if (rel === WS.currentFile && !(en.type === 'dir' || en.is_dir)) row.classList.add('active');
    }
  }

  async function toggleTreeDir(row) {
    const rel = row.dataset.rel || '.';
    const expanded = WS.expanded.has(rel);
    if (expanded) {
      WS.expanded.delete(rel);
      row.setAttribute('aria-expanded', 'false');
      let sib = row.nextElementSibling;
      while (sib && Number(sib.dataset.depth || 0) > Number(row.dataset.depth || 0)) {
        const next = sib.nextElementSibling;
        sib.remove();
        sib = next;
      }
      return;
    }
    row.setAttribute('aria-expanded', 'true');
    row.classList.add('loading');
    let entries;
    try {
      entries = (await listDir(WS.current, rel)).entries || [];
    } catch (e) {
      row.classList.remove('loading');
      row.setAttribute('aria-expanded', 'false');
      wsStatus(tf('dirOpenFailed', rel, e.message), true);
      return;
    }
    row.classList.remove('loading');
    WS.expanded.add(rel);
    // Insert the children right after the row as depth+1 rows — a flat DOM
    // with depth-based indentation keeps toggle-collapse removal simple
    // (remove following siblings until depth returns to this row's level).
    const frag = document.createDocumentFragment();
    appendTreeEntries(frag, entries, Number(row.dataset.depth || 0) + 1);
    row.after(frag);
  }

  function isHtmlFile(rel) {
    return HTML_FILE_RE.test(String(rel || ''));
  }

  // ── preview routing (mirrors core's static/workspace.js format matrix) ───
  // HTML      -> sandboxed iframe of /api/file/raw?inline=1
  // images    -> <img>          PDF      -> iframe of /api/file/raw
  // audio     -> <audio>        video    -> <video>
  // markdown  -> core's renderMd (fallback: plain text)
  // csv/tsv   -> parsed table   code/text-> <pre><code> + Prism when loaded
  // docx      -> docx-preview   xlsx/xls -> SheetJS
  // pptx      -> PptxViewJS canvas (prev/next)
  // Everything else: download prompt (no in-app renderer).
  // Rich parsers are the same vendored bundles core lazy-loads from
  // static/vendor/ (same-origin), so no new network origin is introduced.
  const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp']);
  const MD_EXTS = new Set(['.md', '.markdown', '.mdown']);
  const PDF_EXTS = new Set(['.pdf']);
  const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac']);
  const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.ogv', '.avi', '.mkv']);
  const CSV_EXTS = new Set(['.csv', '.tsv']);
  const DOCX_EXTS = new Set(['.docx']);
  const SHEET_EXTS = new Set(['.xlsx', '.xls']);
  const PPTX_EXTS = new Set(['.pptx']);
  const DOWNLOAD_EXTS = new Set([
    '.doc', '.ppt', '.odt', '.ods', '.odp',
    '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
    '.exe', '.dmg', '.pkg', '.deb', '.rpm',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.bin', '.db', '.sqlite', '.pyc', '.class', '.so', '.dylib', '.dll',
  ]);
  const OFFICE_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
  const CSV_MAX_ROWS = 2000;
  const CSV_MAX_COLS = 100;

  // Vendored parser bundles, byte-for-byte the paths core uses.
  const VENDOR_LIBS = {
    jszip: ['static/vendor/jszip/3.10.2/jszip.min.js', 'JSZip'],
    docxpreview: ['static/vendor/docx-preview/0.4.1/docx-preview.min.js', 'docx'],
    xlsx: ['static/vendor/xlsx/0.18.5/xlsx.full.min.js', 'XLSX'],
    chart: ['static/vendor/chart.js/4.5.1/chart.umd.js', 'Chart'],
    pptxviewer: ['static/vendor/pptxviewjs/1.3.0/PptxViewJS.min.js', 'PptxViewJS'],
  };
  const vendorLoads = {};
  const PPTX = { viewer: null, canvas: null, wrap: null, pageEl: null, prevBtn: null, nextBtn: null, slide: 0 };

  function extOf(rel) {
    const s = String(rel || '');
    const i = s.lastIndexOf('.');
    return i >= 0 ? s.slice(i).toLowerCase() : '';
  }

  function loadVendorLib(key) {
    const spec = VENDOR_LIBS[key];
    if (!spec) return Promise.reject(new Error('unknown lib ' + key));
    if (window[spec[1]]) return Promise.resolve();
    if (vendorLoads[key]) return vendorLoads[key];
    vendorLoads[key] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL(spec[0], document.baseURI || location.href).href;
      s.async = true;
      s.onload = () => {
        if (window[spec[1]]) resolve();
        else { delete vendorLoads[key]; reject(new Error(spec[1] + ' missing after load')); }
      };
      s.onerror = () => { delete vendorLoads[key]; reject(new Error('failed to load ' + spec[0])); };
      document.head.appendChild(s);
    });
    return vendorLoads[key];
  }

  function previewHost() {
    return document.querySelector('#' + OVERLAY_ID + ' .hwx-extapp-preview');
  }

  function destroyPptx() {
    if (PPTX.viewer) { try { PPTX.viewer.destroy(); } catch (_) {} }
    PPTX.viewer = null; PPTX.canvas = null; PPTX.wrap = null;
    PPTX.pageEl = null; PPTX.prevBtn = null; PPTX.nextBtn = null; PPTX.slide = 0;
  }

  function clearPreviewDom() {
    destroyPptx();
    const host = previewHost();
    if (host) host.innerHTML = '';
    return host;
  }

  function setPreviewEmpty() {
    const host = previewHost();
    if (!host) return;
    host.innerHTML = '';
    destroyPptx();
    const empty = document.createElement('div');
    empty.className = 'hwx-extapp-empty hwx-extapp-preview-empty';
    empty.innerHTML = '<p>' + escapeHtml(t('selectFile')) + '</p>' +
      '<p class="hwx-extapp-muted">' + escapeHtml(t('selectFileHint')) + '</p>';
    host.appendChild(empty);
  }

  function setPreviewMessage(text) {
    const host = clearPreviewDom();
    if (!host) return;
    const msg = document.createElement('div');
    msg.className = 'hwx-extapp-empty hwx-extapp-preview-empty';
    msg.textContent = text;
    host.appendChild(msg);
  }

  function setPreviewNode(node) {
    const host = clearPreviewDom();
    if (!host) return null;
    node.classList.add('hwx-extapp-preview-view');
    host.appendChild(node);
    return node;
  }

  function setPreviewFrame(url, titleRel, opts) {
    opts = opts || {};
    const host = clearPreviewDom();
    if (!host) return;
    const frame = document.createElement('iframe');
    frame.className = 'hwx-extapp-iframe';
    frame.src = url;
    frame.setAttribute('title', titleRel || t('preview'));
    // Same-origin /api/file/raw content. For HTML, core already serves
    // &inline=1 with CSP `sandbox allow-scripts ...`; mirror it on the element
    // and keep allow-same-origin OFF so the previewed file stays in an opaque
    // origin.
    //
    // PDF deliberately opts out of the element sandbox (opts.sandbox === false):
    // Chromium renders PDFs with its built-in viewer, and that viewer is
    // refused inside a sandboxed frame — the request dies as
    // net::ERR_BLOCKED_BY_CLIENT. Core's native PDF preview frame
    // (#previewPdfFrame) has no sandbox attribute either. The PDF is parsed by
    // Chromium's viewer (not page script), so this does not widen the HTML
    // preview's isolation.
    if (opts.sandbox !== false) frame.setAttribute('sandbox', WS_IFRAME_SANDBOX);
    frame.setAttribute('referrerpolicy', 'same-origin');
    host.appendChild(frame);
  }

  function setPreviewMedia(kind, url, titleRel) {
    const wrap = document.createElement('div');
    wrap.className = 'hwx-extapp-media-view';
    let el;
    if (kind === 'image') {
      el = document.createElement('img');
      el.alt = titleRel || '';
      el.src = url;
    } else if (kind === 'audio') {
      el = document.createElement('audio');
      el.controls = true;
      el.src = url;
    } else {
      el = document.createElement('video');
      el.controls = true;
      el.src = url;
      el.setAttribute('playsinline', '');
    }
    wrap.appendChild(el);
    setPreviewNode(wrap);
  }

  async function readTextFile(rel) {
    return callSessionApi(WS.current, (sid) =>
      'api/file?session_id=' + encodeURIComponent(sid) + '&path=' + encodeURIComponent(rel));
  }

  async function readFileBytes(rel) {
    const sid = await ensurePreviewSession(WS.current);
    const res = await fetch(rawFileUrl(sid, rel), { credentials: 'include' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.arrayBuffer();
  }

  function prismLangFor(rel) {
    try {
      if (typeof window._prismLanguageForPath === 'function') return window._prismLanguageForPath(rel);
    } catch (_) {}
    return '';
  }

  function renderTextPreview(rel, text) {
    const pre = document.createElement('pre');
    pre.className = 'hwx-extapp-code';
    const code = document.createElement('code');
    code.textContent = String(text == null ? '' : text);
    const lang = prismLangFor(rel);
    if (lang) code.className = 'language-' + lang;
    pre.appendChild(code);
    setPreviewNode(pre);
    if (lang && window.Prism && typeof window.Prism.highlightElement === 'function') {
      try { window.Prism.highlightElement(code); } catch (_) {}
    }
  }

  async function previewMarkdown(rel, gen) {
    const data = await readTextFile(rel);
    if (gen !== WS.previewGen) return;
    const md = document.createElement('div');
    md.className = 'hwx-extapp-md';
    if (typeof window.renderMd === 'function') {
      md.innerHTML = window.renderMd(String(data.content || ''));
    } else {
      const pre = document.createElement('pre');
      pre.textContent = String(data.content || '');
      md.appendChild(pre);
    }
    setPreviewNode(md);
  }

  // Minimal RFC4180-ish parser: quotes, doubled quotes, CRLF. Caps the row and
  // column counts so a huge CSV cannot freeze the frame.
  function parseDelimited(text, delim) {
    const rows = [];
    let row = [];
    let cur = '';
    let quoted = false;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quoted) {
        if (ch === '"') {
          if (s[i + 1] === '"') { cur += '"'; i++; }
          else quoted = false;
        } else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === delim) { row.push(cur); cur = ''; }
      else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (ch !== '\r') cur += ch;
      if (rows.length >= CSV_MAX_ROWS) break;
    }
    if ((cur !== '' || row.length) && rows.length < CSV_MAX_ROWS) { row.push(cur); rows.push(row); }
    return rows.map((r) => r.slice(0, CSV_MAX_COLS));
  }

  async function previewTable(rel, gen) {
    const data = await readTextFile(rel);
    if (gen !== WS.previewGen) return;
    const delim = extOf(rel) === '.tsv' ? '\t' : ',';
    const rows = parseDelimited(data.content, delim);
    const table = document.createElement('table');
    table.className = 'hwx-extapp-table';
    if (rows.length) {
      const thead = document.createElement('thead');
      const hr = document.createElement('tr');
      rows[0].forEach((cell) => {
        const th = document.createElement('th');
        th.textContent = cell;
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      for (let i = 1; i < rows.length; i++) {
        const tr = document.createElement('tr');
        rows[i].forEach((cell) => {
          const td = document.createElement('td');
          td.textContent = cell;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
    }
    setPreviewNode(table);
  }

  async function previewDocx(rel, gen) {
    const buf = await readFileBytes(rel);
    if (gen !== WS.previewGen) return;
    assertOfficeSize(buf);
    await loadVendorLib('jszip');
    await loadVendorLib('docxpreview');
    if (gen !== WS.previewGen) return;
    const body = document.createElement('div');
    body.className = 'hwx-extapp-docx docx';
    setPreviewNode(body);
    // Same options as core: base64 for embedded assets (CSP has no blob: in
    // font-src) and page breaks honoured from Word's saved hints.
    await window.docx.renderAsync(buf, body, body, {
      className: 'docx',
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      useBase64URL: true,
    });
  }

  function assertOfficeSize(buf) {
    if (buf.byteLength > OFFICE_PREVIEW_MAX_BYTES) throw new Error(t('tooLargeFile'));
  }

  async function previewSheet(rel, gen) {
    const buf = await readFileBytes(rel);
    if (gen !== WS.previewGen) return;
    assertOfficeSize(buf);
    await loadVendorLib('xlsx');
    if (gen !== WS.previewGen) return;
    const wb = window.XLSX.read(buf, { type: 'array' });
    const names = wb.SheetNames || [];
    if (!names.length) throw new Error(t('emptySheet'));
    const root = document.createElement('div');
    root.className = 'hwx-extapp-sheet';
    const tabs = document.createElement('div');
    tabs.className = 'hwx-extapp-sheet-tabs';
    const bodyEl = document.createElement('div');
    bodyEl.className = 'hwx-extapp-sheet-body';

    function sheetNode(name) {
      const ws = wb.Sheets[name];
      if (!ws || !ws['!ref']) {
        const empty = document.createElement('div');
        empty.className = 'hwx-extapp-sheet-empty';
        empty.textContent = t('emptySheet');
        return empty;
      }
      const tmp = document.createElement('div');
      tmp.innerHTML = window.XLSX.utils.sheet_to_html(ws, { editable: false });
      return tmp.querySelector('table') || tmp;
    }

    function show(i) {
      bodyEl.innerHTML = '';
      bodyEl.appendChild(sheetNode(names[i]));
      Array.prototype.forEach.call(tabs.children, (b, bi) => b.classList.toggle('active', bi === i));
    }

    names.forEach((name, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hwx-extapp-sheet-tab' + (i === 0 ? ' active' : '');
      b.textContent = name;
      b.addEventListener('click', () => show(i));
      tabs.appendChild(b);
    });
    if (names.length > 1) root.appendChild(tabs);
    root.appendChild(bodyEl);
    setPreviewNode(root);
    show(0);
  }

  async function previewPptx(rel, gen) {
    const buf = await readFileBytes(rel);
    if (gen !== WS.previewGen) return;
    assertOfficeSize(buf);
    await loadVendorLib('jszip');
    await loadVendorLib('chart');
    await loadVendorLib('pptxviewer');
    if (typeof window.PptxViewJS?.PPTXViewer !== 'function') {
      throw new Error('PptxViewJS failed to initialise');
    }
    if (gen !== WS.previewGen) return;
    const wrap = document.createElement('div');
    wrap.className = 'hwx-extapp-pptx';
    const canvas = document.createElement('canvas');
    const nav = document.createElement('div');
    nav.className = 'hwx-extapp-pptx-nav';
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'hwx-extapp-iconbtn';
    prev.textContent = '‹';
    prev.setAttribute('aria-label', t('prevSlide'));
    const page = document.createElement('span');
    page.className = 'hwx-extapp-pptx-page';
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'hwx-extapp-iconbtn';
    next.textContent = '›';
    next.setAttribute('aria-label', t('nextSlide'));
    nav.appendChild(prev);
    nav.appendChild(page);
    nav.appendChild(next);
    wrap.appendChild(canvas);
    wrap.appendChild(nav);
    setPreviewNode(wrap);

    const viewer = new window.PptxViewJS.PPTXViewer({
      canvas,
      substituteCalibri: true,
      fontBaseUrl: new URL('static/vendor/pptxviewjs/1.3.0/fonts/', document.baseURI || location.href).href,
      autoRenderFirstSlide: false,
      logger: {
        debug() {}, info() {},
        warn: (...a) => { try { console.warn(...a); } catch (_) {} },
        error: (...a) => { try { console.error(...a); } catch (_) {} },
      },
    });
    await viewer.loadFile(buf);
    if (gen !== WS.previewGen) { try { viewer.destroy(); } catch (_) {} return; }
    PPTX.viewer = viewer;
    PPTX.canvas = canvas;
    PPTX.wrap = wrap;
    PPTX.pageEl = page;
    PPTX.prevBtn = prev;
    PPTX.nextBtn = next;
    prev.addEventListener('click', () => renderPptxSlide(PPTX.slide - 1).catch(() => {}));
    next.addEventListener('click', () => renderPptxSlide(PPTX.slide + 1).catch(() => {}));
    await renderPptxSlide(0);
  }

  function fitPptxCanvas() {
    if (!PPTX.canvas || !PPTX.wrap) return;
    const availW = Math.max(160, PPTX.wrap.clientWidth - 16);
    const availH = Math.max(90, PPTX.wrap.clientHeight - 52);
    const ratio = 16 / 9;
    let w = availW;
    let h = w / ratio;
    if (h > availH) { h = availH; w = h * ratio; }
    PPTX.canvas.style.width = Math.round(w) + 'px';
    PPTX.canvas.style.height = Math.round(h) + 'px';
  }

  async function renderPptxSlide(idx) {
    const viewer = PPTX.viewer;
    if (!viewer) return;
    const count = typeof viewer.getSlideCount === 'function' ? viewer.getSlideCount() : 0;
    if (!count) return;
    const target = Math.max(0, Math.min(count - 1, idx));
    fitPptxCanvas();
    await viewer.render(PPTX.canvas, { slideIndex: target });
    if (PPTX.viewer !== viewer) return;
    PPTX.slide = target;
    if (PPTX.pageEl) PPTX.pageEl.textContent = (target + 1) + ' / ' + count;
    if (PPTX.prevBtn) PPTX.prevBtn.disabled = target <= 0;
    if (PPTX.nextBtn) PPTX.nextBtn.disabled = target >= count - 1;
  }

  function markActiveRow(rel) {
    document.querySelectorAll('#' + OVERLAY_ID + ' .hwx-extapp-tree-row.active')
      .forEach((r) => r.classList.remove('active'));
    document.querySelectorAll('#' + OVERLAY_ID + ' .hwx-extapp-tree-row')
      .forEach((r) => { if (r.dataset.rel === rel) r.classList.add('active'); });
  }

  async function previewFile(rel, opts) {
    opts = opts || {};
    if (!rel) return;
    const gen = ++WS.previewGen;
    WS.currentFile = rel;
    markActiveRow(rel);
    const cfg = loadCfg();
    if (cfg.lastFile !== rel || cfg.workspace !== WS.current) {
      saveCfg({ ...cfg, workspace: WS.current, lastFile: rel });
    }
    const ext = extOf(rel);
    try {
      if (HTML_FILE_RE.test(rel)) {
        const sid = await ensurePreviewSession(WS.current);
        if (gen !== WS.previewGen) return;
        setPreviewFrame(rawFileUrl(sid, rel, { inline: true, bust: opts.bust }), rel);
      } else if (IMAGE_EXTS.has(ext)) {
        const sid = await ensurePreviewSession(WS.current);
        if (gen !== WS.previewGen) return;
        setPreviewMedia('image', rawFileUrl(sid, rel, { bust: opts.bust }), rel);
      } else if (PDF_EXTS.has(ext)) {
        const sid = await ensurePreviewSession(WS.current);
        if (gen !== WS.previewGen) return;
        // inline=1 is required: without it /api/file/raw falls back to the
        // global security headers, which send X-Frame-Options: DENY and the
        // browser refuses to frame the response (ERR_BLOCKED_BY_RESPONSE).
        // With inline=1 the server sends a CSP `sandbox` policy instead, which
        // keeps the document isolated while remaining frameable — exactly what
        // core's native PDF preview does. No element sandbox: Chromium's PDF
        // viewer cannot run inside one.
        setPreviewFrame(rawFileUrl(sid, rel, { inline: true, bust: opts.bust }), rel, { sandbox: false });
      } else if (AUDIO_EXTS.has(ext) || VIDEO_EXTS.has(ext)) {
        const sid = await ensurePreviewSession(WS.current);
        if (gen !== WS.previewGen) return;
        setPreviewMedia(AUDIO_EXTS.has(ext) ? 'audio' : 'video',
          rawFileUrl(sid, rel, { bust: opts.bust }), rel);
      } else if (MD_EXTS.has(ext)) {
        await previewMarkdown(rel, gen);
      } else if (CSV_EXTS.has(ext)) {
        await previewTable(rel, gen);
      } else if (DOCX_EXTS.has(ext)) {
        await previewDocx(rel, gen);
      } else if (SHEET_EXTS.has(ext)) {
        await previewSheet(rel, gen);
      } else if (PPTX_EXTS.has(ext)) {
        await previewPptx(rel, gen);
      } else if (DOWNLOAD_EXTS.has(ext)) {
        setPreviewMessage(t('unsupportedFile'));
      } else {
        const data = await readTextFile(rel);
        if (gen !== WS.previewGen) return;
        renderTextPreview(rel, data.content);
      }
    } catch (e) {
      if (gen !== WS.previewGen) return;
      setPreviewMessage(t('previewFailedPlain'));
      wsStatus(tf('previewFailed', e.message), true);
    }
  }

  // Bounded shallow search for the first HTML file (root level first, then a
  // small BFS into subdirectories). index.html wins over any other HTML at the
  // same depth. Caps: 3 levels, 24 directory listings.
  async function autoOpenFirstHtml(wsPath, gen) {
    if (!overlayOpen) return;
    let firstHtml = '';
    let indexHtml = '';
    const queue = [{ rel: '.', depth: 0 }];
    let scanned = 0;
    while (queue.length && scanned < 24) {
      if (gen !== WS.gen) return;
      const { rel, depth } = queue.shift();
      if (depth > 3) continue;
      let entries;
      try { entries = (await listDir(wsPath, rel)).entries || []; }
      catch (_) { continue; }
      scanned++;
      for (const en of entries) {
        if (en.type === 'dir' || en.is_dir) {
          if (depth + 1 <= 3) queue.push({ rel: en.path || joinWsPath(rel, en.name), depth: depth + 1 });
          continue;
        }
        const p = en.path || joinWsPath(rel, en.name);
        if (!HTML_FILE_RE.test(en.name || p)) continue;
        if (!firstHtml) firstHtml = p;
        if (!indexHtml && String(en.name || '').toLowerCase() === 'index.html') indexHtml = p;
      }
      if (indexHtml && depth <= 1) break;
    }
    if (gen !== WS.gen) return;
    const pick = indexHtml || firstHtml;
    if (!pick) {
      setPreviewEmpty();
      wsStatus(t('noHtml'), false);
      return;
    }
    if (!overlayOpen || gen !== WS.gen) return;
    await previewFile(pick);
  }

  // ── overlay open/close ───────────────────────────────────────────────────
  function toggleOverlay() { overlayOpen ? closeOverlay() : openOverlay(); }

  function openOverlay() {
    renderOverlayContent();
    const ov = document.getElementById(OVERLAY_ID);
    ov.style.display = 'flex';
    overlayOpen = true;
    const btn = document.getElementById(RAIL_BTN_ID);
    if (btn) btn.classList.add('active');
    document.addEventListener('keydown', escClose, true);
  }
  function closeOverlay() {
    destroyPptx(); // release the canvas + parsed deck while the panel is closed
    const ov = document.getElementById(OVERLAY_ID);
    if (ov) ov.style.display = 'none';
    overlayOpen = false;
    const btn = document.getElementById(RAIL_BTN_ID);
    if (btn) btn.classList.remove('active');
    document.removeEventListener('keydown', escClose, true);
  }
  function escClose(ev) { if (ev.key === 'Escape') closeOverlay(); }

  // ── config dialog ────────────────────────────────────────────────────────
  function openConfig() {
    const cfg = loadCfg();
    let dlg = document.getElementById('hwxExtAppConfig');
    if (dlg) dlg.remove();
    dlg = document.createElement('div');
    dlg.id = 'hwxExtAppConfig';
    dlg.className = 'hwx-extapp-config-dlg';
    dlg.innerHTML =
      '<div class="hwx-extapp-config-card" role="dialog" aria-label="' + escapeHtml(t('configure')) + '">' +
        '<div class="hwx-extapp-config-title">' + escapeHtml(t('configTitle')) + '</div>' +
        '<div class="hwx-extapp-field"><span>' + escapeHtml(t('mode')) + '</span>' +
          '<div class="hwx-extapp-modes" role="radiogroup">' +
            '<label class="hwx-extapp-mode"><input type="radio" name="hwxExtAppMode" value="external"> ' +
              escapeHtml(t('modeExternal')) + '</label>' +
            '<label class="hwx-extapp-mode"><input type="radio" name="hwxExtAppMode" value="workspace"> ' +
              escapeHtml(t('modeWorkspace')) + '</label>' +
          '</div></div>' +
        '<label class="hwx-extapp-field hwx-extapp-f-url"><span>' + escapeHtml(t('labelField')) + '</span>' +
          '<input type="text" class="hwx-extapp-input hwx-extapp-label-in" maxlength="24" placeholder="' +
            escapeHtml(t('labelPlaceholder')) + '"></label>' +
        '<label class="hwx-extapp-field hwx-extapp-f-url"><span>' + escapeHtml(t('urlField')) + '</span>' +
          '<input type="url" class="hwx-extapp-input hwx-extapp-url-in" placeholder="https://app.example.com"></label>' +
        '<div class="hwx-extapp-config-note hwx-extapp-f-url">' + t('cspNote') + '</div>' +
        '<div class="hwx-extapp-config-note hwx-extapp-f-ws" hidden>' + escapeHtml(t('wsNote')) + '</div>' +
        '<div class="hwx-extapp-config-err" hidden></div>' +
        '<div class="hwx-extapp-config-actions">' +
          '<button type="button" class="hwx-extapp-btn hwx-extapp-cancel">' + escapeHtml(t('cancel')) + '</button>' +
          '<button type="button" class="hwx-extapp-btn hwx-extapp-save">' + escapeHtml(t('save')) + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(dlg);
    const labelIn = dlg.querySelector('.hwx-extapp-label-in');
    const urlIn = dlg.querySelector('.hwx-extapp-url-in');
    const err = dlg.querySelector('.hwx-extapp-config-err');
    labelIn.value = cfg.label || '';
    urlIn.value = cfg.url || '';
    const syncModeFields = () => {
      const mode = dlg.querySelector('input[name="hwxExtAppMode"]:checked').value;
      dlg.querySelectorAll('.hwx-extapp-f-url').forEach((el) => { el.hidden = mode === 'workspace'; });
      const wsNote = dlg.querySelector('.hwx-extapp-f-ws');
      if (wsNote) wsNote.hidden = mode !== 'workspace';
    };
    dlg.querySelectorAll('input[name="hwxExtAppMode"]').forEach((r) => {
      r.checked = r.value === cfg.mode;
      r.addEventListener('change', syncModeFields);
    });
    syncModeFields();
    const close = () => dlg.remove();
    dlg.querySelector('.hwx-extapp-cancel').addEventListener('click', close);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
    dlg.querySelector('.hwx-extapp-save').addEventListener('click', () => {
      const mode = dlg.querySelector('input[name="hwxExtAppMode"]:checked').value || 'external';
      const url = urlIn.value.trim();
      const label = (labelIn.value.trim() || 'App').slice(0, 24);
      if (mode === 'external' && url && !validUrl(url)) {
        err.hidden = false;
        err.textContent = t('invalidUrl');
        return;
      }
      saveCfg({ ...loadCfg(), url: mode === 'external' ? url : '', label, mode });
      // refresh rail tooltip + overlay
      const btn = document.getElementById(RAIL_BTN_ID);
      if (btn) { btn.dataset.tooltip = label; btn.setAttribute('aria-label', label); }
      if (overlayOpen) renderOverlayContent();
      close();
    });
  }

  function install(attempt) {
    attempt = attempt || 0;
    if (document.querySelector('.rail')) {
      ensureRailButton();
      window.HermesExternalAppTabExtension = {
        version: '0.2.0',
        getConfig: loadCfg,
        setConfig(url, label) {
          if (url && !validUrl(url)) return false;
          saveCfg({ ...loadCfg(), url: url || '', label: (label || 'App').slice(0, 24) });
          const btn = document.getElementById(RAIL_BTN_ID);
          if (btn) { const c = loadCfg(); btn.dataset.tooltip = c.label; btn.setAttribute('aria-label', c.label); }
          if (overlayOpen) renderOverlayContent();
          return true;
        },
        open: openOverlay,
        close: closeOverlay,
      };
      return true;
    }
    if (attempt < 80) { setTimeout(() => install(attempt + 1), 150); return false; }
    console.warn('[' + EXT + '] rail not found; not installed');
    return false;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => install(), { once: true });
  } else {
    install();
  }
})();
