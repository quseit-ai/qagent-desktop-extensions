(() => {
  'use strict';

  // ── MCP Tool Shortcuts extension for Hermes WebUI ────────────────────────
  // Pin frequently-used MCP tools and get a one-click strip that DRAFTS a
  // ready-to-send natural-language tool request into the composer. It NEVER
  // auto-executes a tool (it does not call /api/mcp/call) — it only inserts a
  // prompt you can review and send.
  //
  // - a "pin" star is added to each tool row in Settings -> MCP Tools
  // - pinned tools appear as clickable chips at the top of the MCP Tools section
  // - clicking a chip drafts "Use the <name> tool (on <server>) to: " into the
  //   composer, focuses it, and switches to chat
  // - pins persist in localStorage and are filtered against the LIVE tool list
  //   (stale / cross-profile pins simply don't render)
  //
  // Credit: design reference is closed core PR #3222 (@AJV20) — the
  // draft-not-execute model, esc()-everything, stale-pin filtering, and the
  // server::name shortcut key. This is the extension form of that idea.

  const EXT = 'mcp-tool-shortcuts';
  if (window.__hermesMcpShortcutsLoaded) return;
  window.__hermesMcpShortcutsLoaded = true;

  const STORE_KEY = 'hermes-ext-mcp-pinned-tools';   // [ "server::name", ... ]
  const STRIP_ID = 'hwxMcpPinStrip';

  function $(id) { return document.getElementById(id); }
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
      pinTool: 'Pin tool',
      unpinTool: 'Unpin tool',
      pinnedTools: 'Pinned tools',
      draftUsing: 'Draft a request using {0}',
      unpin: 'Unpin',
      draftWithServer: 'Use the {0} tool (on the {1} server) to: ',
      draftNoServer: 'Use the {0} tool to: ',
      drafted: 'Drafted a request for "{0}" — review and send',
    },
    zh: {
      pinTool: '固定工具',
      unpinTool: '取消固定工具',
      pinnedTools: '已固定的工具',
      draftUsing: '使用 {0} 起草请求',
      unpin: '取消固定',
      draftWithServer: '使用 {0} 工具（{1} 服务器）来：',
      draftNoServer: '使用 {0} 工具来：',
      drafted: '已起草针对“{0}”的请求 — 请检查后发送',
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

  function toolKey(server, name) { return (server || 'unknown') + '::' + (name || ''); }

  function loadPins() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      const a = JSON.parse(raw);
      return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
    } catch (_) { return []; }
  }
  function savePins(pins) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(pins)); } catch (_) {}
  }

  // ── live tool list (authed endpoint; do NOT rely on the in-page cache) ────
  let liveTools = [];
  function fetchTools() {
    // Always use an ABSOLUTE same-origin fetch. (Do NOT route through window.api:
    // core's api() strips the leading slash and resolves against document.baseURI,
    // so on a /session/<id> route '/api/mcp/tools' becomes '/session/api/mcp/tools'
    // → 404 → silent empty tool list. Codex gate, PR #28.)
    const p = fetch('/api/mcp/tools', { credentials: 'same-origin' })
      .then((r) => r.ok ? r.json() : { tools: [] });
    return Promise.resolve(p).then((r) => {
      liveTools = (r && Array.isArray(r.tools)) ? r.tools : [];
      return liveTools;
    }).catch(() => { liveTools = []; return liveTools; });
  }

  function pinnedLiveTools() {
    const pins = new Set(loadPins());
    return liveTools.filter((t) => pins.has(toolKey(t.server, t.name)));
  }

  function isPinned(server, name) {
    return loadPins().indexOf(toolKey(server, name)) >= 0;
  }
  function togglePin(server, name) {
    const key = toolKey(server, name);
    let pins = loadPins();
    if (pins.indexOf(key) >= 0) pins = pins.filter((k) => k !== key);
    else pins.push(key);
    savePins(pins);
    renderStrip();
    decorateRows();
  }

  // ── draft a prompt into the composer (NEVER execute) ─────────────────────
  function draftPrompt(tool) {
    const input = $('msg');
    if (!input) return;
    const name = tool.name || 'tool';
    const draft = tool.server
      ? tf('draftWithServer', name, tool.server)
      : tf('draftNoServer', name);
    // switch to chat so the composer is visible
    if (typeof window.switchPanel === 'function') {
      try { window.switchPanel('chat'); } catch (_) {}
    }
    // close settings overlay if open (best-effort; harmless if not)
    input.value = draft;
    input.focus();
    // place caret at end
    try { input.selectionStart = input.selectionEnd = input.value.length; } catch (_) {}
    // let the composer enable its send button / autosize
    input.dispatchEvent(new Event('input', { bubbles: true }));
    toast(tf('drafted', name));
  }

  // ── the pinned-tools strip (top of the MCP Tools section) ────────────────
  function mcpToolsSection() {
    const list = $('mcpToolList');
    return list ? list.parentElement : null;   // the settings-field wrapping the tools
  }

  function renderStrip() {
    const section = mcpToolsSection();
    if (!section) return;
    let strip = $(STRIP_ID);
    const pinned = pinnedLiveTools();
    if (!pinned.length) {
      if (strip) strip.remove();
      return;
    }
    if (!strip) {
      strip = document.createElement('div');
      strip.id = STRIP_ID;
      strip.className = 'hwx-mcp-strip';
      // insert just before the tool list (above search results)
      const list = $('mcpToolList');
      section.insertBefore(strip, list);
    }
    let html = '<div class="hwx-mcp-strip-title">\u2605 ' + escapeHtml(t('pinnedTools')) +
      '</div><div class="hwx-mcp-chips">';
    pinned.forEach((tool, i) => {
      html += '<span class="hwx-mcp-chip" data-i="' + i + '" role="button" tabindex="0" ' +
        'title="' + tf('draftUsing', escapeHtml(tool.name)) + '">' +
        '<span class="hwx-mcp-chip-name">' + escapeHtml(tool.name) + '</span>' +
        '<span class="hwx-mcp-chip-server">' + escapeHtml(tool.server || '') + '</span>' +
        '<button type="button" class="hwx-mcp-chip-x" data-i="' + i + '" aria-label="' +
        escapeHtml(t('unpin')) + '" title="' + escapeHtml(t('unpin')) + '">\u00d7</button>' +
        '</span>';
    });
    html += '</div>';
    strip.innerHTML = html;
    // wire chips
    strip.querySelectorAll('.hwx-mcp-chip').forEach((chip) => {
      const tool = pinned[parseInt(chip.dataset.i, 10)];
      chip.addEventListener('click', (e) => {
        if (e.target.closest('.hwx-mcp-chip-x')) return;
        draftPrompt(tool);
      });
      chip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); draftPrompt(tool); }
      });
    });
    strip.querySelectorAll('.hwx-mcp-chip-x').forEach((x) => {
      const tool = pinned[parseInt(x.dataset.i, 10)];
      x.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        togglePin(tool.server, tool.name);
      });
    });
  }

  // ── pin stars on each tool row ───────────────────────────────────────────
  function decorateRows() {
    const list = $('mcpToolList');
    if (!list) return;
    list.querySelectorAll('.mcp-tool-row').forEach((row) => {
      const nameEl = row.querySelector('.mcp-tool-name');
      const serverEl = row.querySelector('.mcp-tool-server');
      if (!nameEl) return;
      const name = nameEl.textContent.trim();
      const server = serverEl ? serverEl.textContent.trim() : '';
      const pinned = isPinned(server, name);
      let star = row.querySelector(':scope .hwx-mcp-star');
      if (!star) {
        star = document.createElement('button');
        star.type = 'button';
        star.className = 'hwx-mcp-star';
        const head = row.querySelector('.mcp-server-row-head') || row;
        head.appendChild(star);
      }
      star.classList.toggle('hwx-mcp-star--on', pinned);
      star.title = t(pinned ? 'unpinTool' : 'pinTool');
      star.setAttribute('aria-label', star.title);
      star.setAttribute('aria-pressed', pinned ? 'true' : 'false');
      star.innerHTML = starSvg(pinned);
      if (!star.dataset.wired) {
        star.dataset.wired = '1';
        star.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          const n = nameEl.textContent.trim();
          const s = serverEl ? serverEl.textContent.trim() : '';
          togglePin(s, n);
        });
      }
    });
  }

  function starSvg(filled) {
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="' + (filled ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  }

  // ── toast ─────────────────────────────────────────────────────────────────
  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'hwx-mcp-toast'; el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('hwx-mcp-toast--in'), 10);
    setTimeout(() => { el.classList.remove('hwx-mcp-toast--in'); setTimeout(() => el.remove(), 250); }, 2400);
  }

  // ── observe the MCP tool list re-rendering (pagination/search/panel open) ──
  let raf = false;
  function schedule() {
    if (raf) return; raf = true;
    requestAnimationFrame(() => { raf = false; try { renderStrip(); decorateRows(); } catch (_) {} });
  }

  function startObserver() {
    const list = $('mcpToolList');
    if (!list) return false;
    const obs = new MutationObserver(schedule);
    // childList only (NOT subtree): decorateRows() rewrites star.innerHTML, and a
    // subtree observer would re-trigger on our own mutation → rAF/decorate loop.
    // Core renders MCP rows as direct children of #mcpToolList. (Codex gate, PR #28.)
    obs.observe(list, { childList: true });
    return true;
  }

  function refreshAll() {
    return fetchTools().then(() => { renderStrip(); decorateRows(); });
  }

  function install(attempt) {
    attempt = attempt || 0;
    if ($('mcpToolList')) {
      startObserver();
      refreshAll();
      window.HermesMcpShortcutsExtension = {
        version: '0.1.0',
        pins: loadPins,
        refresh: refreshAll,
        _draft: draftPrompt,
      };
      return true;
    }
    // The MCP Tools list only exists once Settings → MCP Tools has rendered.
    // Watch the document for it appearing, then install once.
    if (!window.__hermesMcpShortcutsWatching) {
      window.__hermesMcpShortcutsWatching = true;
      const bodyObs = new MutationObserver(() => {
        if ($('mcpToolList')) {
          bodyObs.disconnect();
          window.__hermesMcpShortcutsWatching = false;
          install();
        }
      });
      bodyObs.observe(document.body, { childList: true, subtree: true });
    }
    return false;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => install(), { once: true });
  } else {
    install();
  }
})();
