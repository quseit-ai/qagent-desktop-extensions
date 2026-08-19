/* Whisper Model Installer - one-click install of the faster-whisper-base
   speech-to-text model into the default Hugging Face cache directory.

   Downloads run in the extension's loopback sidecar (token-v1, consented in
   Settings -> Extensions) against the hf-mirror.com mirror; the panel is a
   small modal with live progress (start-job + poll - the WebUI proxy buffers
   requests, so no long-held calls). No localStorage, no external scripts. */
(function () {
  'use strict';
  if (window.__whisperModelInstaller) return; window.__whisperModelInstaller = true;
  var EXT = 'whisper-model-installer';
  var BASE = '/api/extensions/' + EXT + '/sidecar';
  var POLL_MS = 1000;

  var _pollTimer = null;
  var _installing = false;

  // Consent is granted by the user in Settings -> Extensions; we NEVER
  // auto-grant it. Resolve this extension's sidecar record, fail closed.
  function sidecarConsented() {
    return fetch('/api/extensions/status', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var recs = (d && Array.isArray(d.sidecars)) ? d.sidecars : [];
        for (var i = 0; i < recs.length; i++) {
          if (recs[i] && recs[i].id === EXT) {
            var p = recs[i].proxy || {};
            return !!(p.consented && !p.consent_required);
          }
        }
        return false;
      }).catch(function () { return false; });
  }

  function api(path, opts) {
    return fetch(BASE + path, Object.assign({ credentials: 'same-origin' }, opts || {}))
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (body) {
          if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
          return body;
        });
      });
  }

  function fmtBytes(n) {
    if (!n || n < 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + units[i];
  }

  function el(id) { return document.getElementById(id); }

  function setBar(pct) {
    var bar = el('hxWhisperBar');
    if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }

  function setStatus(text, tone) {
    var node = el('hxWhisperStatus');
    if (!node) return;
    node.textContent = text || '';
    node.className = 'hx-whisper-status' + (tone ? ' hx-whisper-status--' + tone : '');
  }

  function setButtons(state) {
    var install = el('hxWhisperInstallBtn');
    var cancel = el('hxWhisperCancelBtn');
    if (!install || !cancel) return;
    install.disabled = state === 'running' || state === 'canceling';
    cancel.hidden = state !== 'running' && state !== 'canceling';
    install.textContent = state === 'running' || state === 'canceling' ? 'Installing…' : 'Install faster-whisper-base';
  }

  function stopPoll() {
    if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
  }

  function poll() {
    stopPoll();
    api('/api/install').then(function (job) {
      var p = job.progress || {};
      if (job.state === 'running' || job.state === 'canceling') {
        _installing = true;
        var pct = 0;
        if (p.total_known && p.total_bytes > 0) pct = (p.downloaded_bytes / p.total_bytes) * 100;
        else pct = (p.files_done / Math.max(1, p.files_total)) * 50; // indeterminate: half-credit per file
        setBar(pct);
        setStatus(
          (job.state === 'canceling' ? 'Canceling… ' : '') +
          (p.current_file ? p.current_file + ' — ' : '') +
          fmtBytes(p.downloaded_bytes) + (p.total_known ? ' / ' + fmtBytes(p.total_bytes) : '') +
          ' (' + p.files_done + '/' + p.files_total + ' files)',
          'busy'
        );
        setButtons(job.state);
        _pollTimer = setTimeout(poll, POLL_MS);
        return;
      }
      _installing = false;
      setButtons('idle');
      if (job.state === 'done') {
        setBar(100);
        setStatus('Installed ✓  ' + ((job.result && job.result.snapshot_path) || ''), 'ok');
        refreshStatus();
      } else if (job.state === 'canceled') {
        setStatus('Download canceled.', 'warn');
      } else if (job.state === 'error') {
        setStatus('Install failed: ' + (job.error || 'unknown error'), 'err');
      } else if (job.state === 'idle') {
        refreshStatus();
      }
    }).catch(function (e) {
      _installing = false;
      setButtons('idle');
      setStatus('Sidecar unreachable: ' + e.message, 'err');
    });
  }

  function refreshStatus() {
    api('/api/status').then(function (d) {
      var install = (d && d.install) || {};
      var model = (d && d.model) || {};
      if (!_installing) {
        if (install.installed) {
          setBar(100);
          setStatus('Already installed ✓  ' + (install.snapshot_path || ''), 'ok');
        } else {
          setBar(0);
          setStatus('Not installed. Downloads from ' + (d.mirror || 'the mirror') + ' (~' + (model.size_hint || '150 MB') + ') into your default Hugging Face cache.');
        }
        setButtons('idle');
      }
      var meta = el('hxWhisperMeta');
      if (meta) {
        meta.textContent =
          (model.repo_id || 'Systran/faster-whisper-base') +
          '  ·  cache: ' + (install.cache_dir || 'default Hugging Face cache');
      }
    }).catch(function (e) {
      setStatus('Sidecar unreachable: ' + e.message, 'err');
    });
  }

  function startInstall() {
    setStatus('Contacting mirror…', 'busy');
    setButtons('running');
    api('/api/install', { method: 'POST' }).then(function () {
      _installing = true;
      poll();
    }).catch(function (e) {
      setButtons('idle');
      setStatus('Could not start install: ' + e.message, 'err');
    });
  }

  function cancelInstall() {
    api('/api/install/cancel', { method: 'POST' }).then(poll).catch(function () { poll(); });
  }

  function buildUI() {
    if (!document.body || el('hxWhisperOverlay')) return;
    var overlay = document.createElement('div');
    overlay.id = 'hxWhisperOverlay';
    overlay.className = 'hx-whisper-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML =
      '<div class="hx-whisper-card" role="dialog" aria-modal="true" aria-label="Whisper Model Installer" tabindex="-1">' +
        '<div class="hx-whisper-topbar">' +
          '<span class="hx-whisper-title">' +
            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>' +
            ' Whisper Model Installer</span>' +
          '<button type="button" class="hx-whisper-close" id="hxWhisperClose" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="hx-whisper-body">' +
          '<div class="hx-whisper-meta" id="hxWhisperMeta"></div>' +
          '<div class="hx-whisper-progress"><div class="hx-whisper-progress-fill" id="hxWhisperBar"></div></div>' +
          '<div class="hx-whisper-status" id="hxWhisperStatus">Checking…</div>' +
        '</div>' +
        '<div class="hx-whisper-actions">' +
          '<button type="button" class="hx-whisper-btn hx-whisper-btn--primary" id="hxWhisperInstallBtn">Install faster-whisper-base</button>' +
          '<button type="button" class="hx-whisper-btn" id="hxWhisperCancelBtn" hidden>Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    el('hxWhisperClose').addEventListener('click', close);
    el('hxWhisperInstallBtn').addEventListener('click', startInstall);
    el('hxWhisperCancelBtn').addEventListener('click', cancelInstall);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay.style.display !== 'none') { e.stopPropagation(); close(); }
    }, true);

    // Launcher: a small floating mic button, independent of WebUI core DOM so
    // it survives upstream markup changes.
    var launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.id = 'hxWhisperLauncher';
    launcher.className = 'hx-whisper-launcher';
    launcher.setAttribute('aria-label', 'Whisper Model Installer');
    launcher.title = 'Whisper Model Installer';
    launcher.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
    launcher.addEventListener('click', open);
    document.body.appendChild(launcher);
  }

  function open() {
    var overlay = el('hxWhisperOverlay');
    if (!overlay) return;
    overlay.style.display = '';
    setStatus('Checking…');
    sidecarConsented().then(function (ok) {
      if (!ok) {
        setStatus('Sidecar not approved yet - grant consent in Settings → Extensions, and make sure the sidecar is running on 127.0.0.1:17799.', 'warn');
        setButtons('blocked');
        return;
      }
      refreshStatus();
      poll(); // pick up an in-flight install after a page reload
    });
  }

  function close() {
    stopPoll();
    var overlay = el('hxWhisperOverlay');
    if (overlay) overlay.style.display = 'none';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUI);
  } else {
    buildUI();
  }
})();
