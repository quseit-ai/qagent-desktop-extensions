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
  function legacyLoadCfg() {
    try {
      const raw = localStorage.getItem(CFG_KEY);
      if (!raw) return { url: '', label: 'App', mode: 'external', workspace: '', lastFile: '' };
      const c = JSON.parse(raw) || {};
      return {
        url: typeof c.url === 'string' ? c.url : '',
        label: c.label || 'App',
        mode: c.mode === 'workspace' ? 'workspace' : 'external',
        workspace: typeof c.workspace === 'string' ? c.workspace : '',
        lastFile: typeof c.lastFile === 'string' ? c.lastFile : '',
      };
    } catch (_) { return { url: '', label: 'App', mode: 'external', workspace: '', lastFile: '' }; }
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
      return {
        url: typeof url === 'string' ? url : '',
        label: (typeof label === 'string' && label) || 'App',
        mode: mode === 'workspace' ? 'workspace' : 'external',
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
      mode: cfg.mode === 'workspace' ? 'workspace' : 'external',
      workspace: cfg.workspace || '',
      lastFile: cfg.lastFile || '',
    };
    const s = extSettings();
    if (s) {
      try {
        s.set('url', next.url); s.set('label', next.label); s.set('mode', next.mode);
        s.set('workspace', next.workspace); s.set('lastFile', next.lastFile);
        return;
      } catch (_) {}
    }
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
    btn.setAttribute('aria-label', cfg.label || 'External app');
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
          '<span class="hwx-extapp-wslabel">Workspace</span>' +
          '<select class="hwx-extapp-ws-select" aria-label="Workspace"></select>' +
        '</label>' +
        '<span class="hwx-extapp-spacer"></span>' +
        iconBtn('config', 'Configure') +
        iconBtn('open', 'Open in new tab') +
        iconBtn('refresh', 'Refresh') +
        iconBtn('files-btn', 'Toggle file list', 'files') +
        iconBtn('close', 'Close') +
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
            window.open(rawFileUrl(sid, WS.currentFile), '_blank', 'noopener');
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
    ov.querySelector('.hwx-extapp-refresh').hidden = !isWs;
    ov.querySelector('.hwx-extapp-files-btn').hidden = !isWs;
    if (isWs) {
      renderWorkspaceContent(ov);
      return;
    }
    ov.querySelector('.hwx-extapp-title').textContent = cfg.label || 'External app';
    const body = ov.querySelector('.hwx-extapp-body');
    body.innerHTML = '';
    if (!validUrl(cfg.url)) {
      const empty = document.createElement('div');
      empty.className = 'hwx-extapp-empty';
      empty.innerHTML =
        '<p>No app configured yet.</p>' +
        '<p class="hwx-extapp-muted">Set a URL to embed a compatible self-hosted web app as a tab.</p>' +
        '<button type="button" class="hwx-extapp-btn hwx-extapp-config-cta">Configure…</button>';
      empty.querySelector('.hwx-extapp-config-cta').addEventListener('click', () => openConfig());
      body.appendChild(empty);
      return;
    }
    const frame = document.createElement('iframe');
    frame.className = 'hwx-extapp-iframe';
    frame.src = cfg.url;
    frame.setAttribute('title', cfg.label || 'External app');
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
    hint.innerHTML = 'If this stays blank, the page may be blocked by the WebUI ' +
      'Content-Security-Policy. Allow it (operator) with ' +
      '<code>HERMES_WEBUI_CSP_FRAME_EXTRA="' + escapeHtml(originOf(cfg.url)) + '"</code>.';
    body.appendChild(frame);
    body.appendChild(hint);
  }

  function originOf(u) { try { return new URL(u).origin; } catch (_) { return u; } }

  // ── workspace mode: bar + file tree + preview ────────────────────────────
  function renderWorkspaceContent(ov) {
    const cfg = loadCfg();
    const body = ov.querySelector('.hwx-extapp-body');
    body.innerHTML = '';
    // Title stays the app label; the workspace name lives in the switcher.
    ov.querySelector('.hwx-extapp-title').textContent = cfg.label || 'App';

    // The switcher lives in the top bar next to the label. Repopulate it per
    // render; its change listener is attached once (marked via dataset).
    const wsSel = ov.querySelector('.hwx-extapp-ws-select');
    if (!wsSel.dataset.bound) {
      wsSel.dataset.bound = '1';
      wsSel.addEventListener('change', () => {
        if (wsSel.value && wsSel.value !== WS.current) switchWorkspace(wsSel.value, { restore: false });
      });
    }
    wsSel.innerHTML = '';
    wsSel.appendChild(new Option('Loading…', ''));

    // Body: preview area (left) + collapsible file tree (right).
    const wrap = document.createElement('div');
    wrap.className = 'hwx-extapp-ws-body';
    const preview = document.createElement('div');
    preview.className = 'hwx-extapp-preview';
    const empty = document.createElement('div');
    empty.className = 'hwx-extapp-empty hwx-extapp-preview-empty';
    empty.innerHTML = '<p>Select a file to preview.</p>' +
      '<p class="hwx-extapp-muted">HTML files render in a sandboxed frame; images, PDFs and text show inline.</p>';
    preview.appendChild(empty);
    const aside = document.createElement('aside');
    aside.className = 'hwx-extapp-files';
    aside.innerHTML =
      '<div class="hwx-extapp-files-head">Files</div>' +
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
      .catch((e) => wsStatus('Workspace list unavailable: ' + e.message, true));
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
      wsSel.appendChild(new Option('No workspaces', ''));
      wsSel.disabled = true;
      wsStatus('No workspaces are configured for this profile yet.', true);
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
    WS.current = wsPath;
    WS.expanded = new Set();
    WS.currentFile = '';
    const cfg = loadCfg();
    saveCfg({ ...cfg, workspace: wsPath, lastFile: '' });
    // Title stays the app label; the active workspace name is carried by the
    // switcher (and its selected option) in the top bar.
    const title = document.querySelector('#' + OVERLAY_ID + ' .hwx-extapp-title');
    if (title) title.textContent = cfg.label || 'App';
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
    wsStatus('Loading files…', false);
    let entries;
    try {
      entries = (await listDir(WS.current, '.')).entries || [];
    } catch (e) {
      if (gen !== WS.gen) return;
      wsStatus('Could not list workspace: ' + e.message, true);
      return;
    }
    if (gen !== WS.gen) return;
    wsStatus('', false);
    appendTreeEntries(tree, entries, 0);
    if (!entries.length) wsStatus('This workspace is empty.', false);
  }

  async function reloadTree(opts) {
    opts = opts || {};
    const gen = ++WS.gen;
    WS.expanded = new Set();
    await loadTreeRoot(gen);
    if (opts.bustPreview && WS.currentFile && gen === WS.gen) {
      try {
        const sid = await ensurePreviewSession(WS.current);
        setPreviewFrame(rawFileUrl(sid, WS.currentFile, { inline: isHtmlFile(WS.currentFile), bust: true }));
      } catch (_) {}
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
      wsStatus('Could not open ' + rel + ': ' + e.message, true);
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

  function setPreviewEmpty() {
    const preview = document.querySelector('#' + OVERLAY_ID + ' .hwx-extapp-preview');
    if (!preview) return;
    preview.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'hwx-extapp-empty hwx-extapp-preview-empty';
    empty.innerHTML = '<p>Select a file to preview.</p>' +
      '<p class="hwx-extapp-muted">HTML files render in a sandboxed frame; images, PDFs and text show inline.</p>';
    preview.appendChild(empty);
  }

  function setPreviewFrame(url, titleRel) {
    const preview = document.querySelector('#' + OVERLAY_ID + ' .hwx-extapp-preview');
    if (!preview) return;
    preview.innerHTML = '';
    const frame = document.createElement('iframe');
    frame.className = 'hwx-extapp-iframe';
    frame.src = url;
    frame.setAttribute('title', titleRel || 'Preview');
    // Same-origin /api/file/raw content. Core already serves &inline=1 HTML
    // with CSP `sandbox allow-scripts ...`; mirror it on the element and keep
    // allow-same-origin OFF so the previewed file stays in an opaque origin.
    frame.setAttribute('sandbox', WS_IFRAME_SANDBOX);
    frame.setAttribute('referrerpolicy', 'same-origin');
    preview.appendChild(frame);
  }

  async function previewFile(rel) {
    if (!rel) return;
    try {
      const sid = await ensurePreviewSession(WS.current);
      WS.currentFile = rel;
      setPreviewFrame(rawFileUrl(sid, rel, { inline: isHtmlFile(rel) }), rel);
      document.querySelectorAll('#' + OVERLAY_ID + ' .hwx-extapp-tree-row.active')
        .forEach((r) => r.classList.remove('active'));
      document.querySelectorAll('#' + OVERLAY_ID + ' .hwx-extapp-tree-row')
        .forEach((r) => { if (r.dataset.rel === rel) r.classList.add('active'); });
      const cfg = loadCfg();
      if (cfg.lastFile !== rel || cfg.workspace !== WS.current) saveCfg({ ...cfg, workspace: WS.current, lastFile: rel });
    } catch (e) {
      wsStatus('Preview failed: ' + e.message, true);
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
      wsStatus('No HTML files found in this workspace.', false);
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
      '<div class="hwx-extapp-config-card" role="dialog" aria-label="Configure external app">' +
        '<div class="hwx-extapp-config-title">External app tab</div>' +
        '<div class="hwx-extapp-field"><span>Mode</span>' +
          '<div class="hwx-extapp-modes" role="radiogroup">' +
            '<label class="hwx-extapp-mode"><input type="radio" name="hwxExtAppMode" value="external"> External URL</label>' +
            '<label class="hwx-extapp-mode"><input type="radio" name="hwxExtAppMode" value="workspace"> Workspace files</label>' +
          '</div></div>' +
        '<label class="hwx-extapp-field hwx-extapp-f-url"><span>Label</span>' +
          '<input type="text" class="hwx-extapp-input hwx-extapp-label-in" maxlength="24" placeholder="App"></label>' +
        '<label class="hwx-extapp-field hwx-extapp-f-url"><span>URL (http/https)</span>' +
          '<input type="url" class="hwx-extapp-input hwx-extapp-url-in" placeholder="https://app.example.com"></label>' +
        '<div class="hwx-extapp-config-note hwx-extapp-f-url">To frame an external origin, the operator must allow it via ' +
          '<code>HERMES_WEBUI_CSP_FRAME_EXTRA</code>. Same-origin / loopback URLs work without it.</div>' +
        '<div class="hwx-extapp-config-note hwx-extapp-f-ws" hidden>Workspace mode browses the profile\'s trusted workspaces ' +
          '(Settings → Workspaces) and previews local files in a sandboxed frame — same-origin, no CSP change needed. ' +
          'Pick the workspace from the switcher inside the panel.</div>' +
        '<div class="hwx-extapp-config-err" hidden></div>' +
        '<div class="hwx-extapp-config-actions">' +
          '<button type="button" class="hwx-extapp-btn hwx-extapp-cancel">Cancel</button>' +
          '<button type="button" class="hwx-extapp-btn hwx-extapp-save">Save</button>' +
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
        err.textContent = 'Enter a valid http(s) URL (or leave blank to clear).';
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
