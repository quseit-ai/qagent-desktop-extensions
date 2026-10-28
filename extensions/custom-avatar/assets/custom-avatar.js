(() => {
  'use strict';

  // ── Custom Avatar extension for Hermes WebUI ─────────────────────────────
  // Lets you give the assistant a custom avatar image in the chat transcript.
  // The assistant role badge (.role-icon.assistant) is normally a single-letter
  // glyph; this swaps in your chosen image. Click any assistant avatar to open a
  // small picker (upload / clear). The image is downscaled and stored as a
  // data-URL in localStorage, and re-applied after the transcript re-renders.
  //
  // Scope note: the WebUI deliberately renders no avatar on USER messages
  // (right-aligned bubble — position identifies the sender), so there is no
  // user-side avatar slot to customize. This extension customizes the assistant
  // avatar, which is the badge that actually exists in the DOM.
  //
  // Pure DOM-injection, client-side only — no core changes, no backend.

  const EXT = 'custom-avatar';
  if (window.__hermesCustomAvatarLoaded) return;
  window.__hermesCustomAvatarLoaded = true;

  const STORAGE_KEY = 'hermes-ext-assistant-avatar';   // stores a data-URL (or empty)
  const MAX_DIM = 64;                                   // downscale target (px)
  const MAX_BYTES = 96 * 1024;                          // refuse images that won't downscale small enough
  const APPLIED_FLAG = 'hwxAvatar';

  // ── i18n (en / zh) ───────────────────────────────────────────────────────
  // Core exposes its active locale via <html lang> and localStorage
  // 'hermes-lang' ('en', 'zh', 'zh-Hant', …). Extension bundles cannot
  // register into core's dictionary, so keep a small local one and follow the
  // page language. Read live (no cache) so a locale switch is picked up on
  // the next render without a reload.
  const STR = {
    en: {
      dialogTitle: 'Assistant avatar',
      clickToSet: 'Click to set a custom assistant avatar',
      upload: 'Upload image…',
      change: 'Change image…',
      remove: 'Remove avatar',
      processing: 'Processing…',
      altAvatar: 'assistant avatar',
      errNotImage: 'Not an image file.',
      errTooLarge: 'Image too large (max 8 MB before downscale).',
      errRead: 'Could not read the file.',
      errDecode: 'Could not decode the image.',
      errTooSmall: 'Image could not be reduced small enough.',
      errProcess: 'Image processing failed.',
    },
    zh: {
      dialogTitle: '助手头像',
      clickToSet: '点击设置自定义助手头像',
      upload: '上传图片…',
      change: '更换图片…',
      remove: '移除头像',
      processing: '处理中…',
      altAvatar: '助手头像',
      errNotImage: '不是图片文件。',
      errTooLarge: '图片过大（压缩前上限 8 MB）。',
      errRead: '无法读取文件。',
      errDecode: '无法解码该图片。',
      errTooSmall: '图片无法压缩到足够小。',
      errProcess: '图片处理失败。',
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

  let observer = null;
  let picker = null;

  function getAvatar() {
    try { return localStorage.getItem(STORAGE_KEY) || ''; } catch (_) { return ''; }
  }
  function setAvatar(dataUrl) {
    try {
      if (dataUrl) localStorage.setItem(STORAGE_KEY, dataUrl);
      else localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
    applyAll();
  }

  function isDataImage(s) {
    return typeof s === 'string' && /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(s);
  }

  // ── apply / clear the avatar on assistant role icons ─────────────────────
  function applyToIcon(icon, dataUrl) {
    if (!icon) return;
    if (dataUrl && isDataImage(dataUrl)) {
      if (icon.dataset[APPLIED_FLAG] !== dataUrl) {
        // Render the image, hiding the letter glyph. Keep the glyph text as a
        // fallback child we can restore on clear.
        if (!icon.dataset.hwxGlyph) icon.dataset.hwxGlyph = icon.textContent || '';
        icon.textContent = '';
        let img = icon.querySelector(':scope > img.hwx-avatar-img');
        if (!img) {
          img = document.createElement('img');
          img.className = 'hwx-avatar-img';
          img.alt = t('altAvatar');
          icon.appendChild(img);
        }
        img.src = dataUrl;
        icon.classList.add('hwx-avatar-set');
        icon.dataset[APPLIED_FLAG] = dataUrl;
      }
    } else {
      // No avatar set: ensure we restore the glyph if we'd replaced it.
      const img = icon.querySelector(':scope > img.hwx-avatar-img');
      if (img) img.remove();
      if (icon.classList.contains('hwx-avatar-set')) {
        icon.classList.remove('hwx-avatar-set');
        if (icon.dataset.hwxGlyph && !icon.textContent) icon.textContent = icon.dataset.hwxGlyph;
      }
      delete icon.dataset[APPLIED_FLAG];
    }
    wireClick(icon);
  }

  function wireClick(icon) {
    // Refresh the tooltip on every apply pass so a locale switch is reflected
    // on the next render; the click wiring itself only needs to happen once.
    icon.title = t('clickToSet');
    if (icon.dataset.hwxAvatarWired) return;
    icon.dataset.hwxAvatarWired = '1';
    icon.style.cursor = 'pointer';
    icon.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openPicker(icon);
    });
  }

  function applyAll() {
    const dataUrl = getAvatar();
    document.querySelectorAll('.role-icon.assistant').forEach((icon) => applyToIcon(icon, dataUrl));
  }

  // ── image handling: downscale to a small square data-URL ─────────────────
  function downscaleToDataUrl(file, cb) {
    if (!file || !/^image\//.test(file.type)) { cb(null, t('errNotImage')); return; }
    if (file.size > 8 * 1024 * 1024) { cb(null, t('errTooLarge')); return; }
    const reader = new FileReader();
    reader.onerror = () => cb(null, t('errRead'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => cb(null, t('errDecode'));
      img.onload = () => {
        try {
          const side = Math.min(MAX_DIM, Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = MAX_DIM; canvas.height = MAX_DIM;
          const ctx = canvas.getContext('2d');
          // cover-fit into a square
          const scale = Math.max(MAX_DIM / img.width, MAX_DIM / img.height);
          const w = img.width * scale, h = img.height * scale;
          ctx.drawImage(img, (MAX_DIM - w) / 2, (MAX_DIM - h) / 2, w, h);
          let out = canvas.toDataURL('image/png');
          if (out.length > MAX_BYTES) out = canvas.toDataURL('image/jpeg', 0.85);
          if (out.length > MAX_BYTES) { cb(null, t('errTooSmall')); return; }
          cb(out, null);
        } catch (e) { cb(null, t('errProcess')); }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  // ── picker popover ───────────────────────────────────────────────────────
  function closePicker() {
    if (picker) { picker.remove(); picker = null; }
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', esc, true);
  }
  function outside(ev) { if (picker && !picker.contains(ev.target)) closePicker(); }
  function esc(ev) { if (ev.key === 'Escape') closePicker(); }

  function openPicker(anchor) {
    closePicker();
    picker = document.createElement('div');
    picker.className = 'hwx-avatar-picker';
    picker.setAttribute('role', 'dialog');
    picker.setAttribute('aria-label', t('dialogTitle'));

    const title = document.createElement('div');
    title.className = 'hwx-avatar-picker-title';
    title.textContent = t('dialogTitle');
    picker.appendChild(title);

    const fileBtn = document.createElement('button');
    fileBtn.type = 'button';
    fileBtn.className = 'hwx-avatar-btn';
    fileBtn.textContent = t(getAvatar() ? 'change' : 'upload');
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp';
    input.style.display = 'none';
    fileBtn.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (!f) return;
      setStatus(t('processing'));
      downscaleToDataUrl(f, (dataUrl, err) => {
        if (err) { setStatus(err); return; }
        setAvatar(dataUrl);
        closePicker();
      });
    });
    picker.appendChild(fileBtn);
    picker.appendChild(input);

    if (getAvatar()) {
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'hwx-avatar-btn hwx-avatar-btn--clear';
      clearBtn.textContent = t('remove');
      clearBtn.addEventListener('click', () => { setAvatar(''); closePicker(); });
      picker.appendChild(clearBtn);
    }

    const status = document.createElement('div');
    status.className = 'hwx-avatar-status';
    status.id = 'hwxAvatarStatus';
    picker.appendChild(status);

    document.body.appendChild(picker);
    position(anchor);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', esc, true);
  }

  function setStatus(msg) {
    const s = document.getElementById('hwxAvatarStatus');
    if (s) s.textContent = msg || '';
  }

  function position(anchor) {
    if (!picker || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = picker.offsetWidth || 200;
    let left = r.left;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
    if (left < 8) left = 8;
    picker.style.left = left + 'px';
    let top = r.bottom + 6;
    const h = picker.offsetHeight || 0;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    picker.style.top = top + 'px';
  }

  // ── observe transcript re-renders ────────────────────────────────────────
  let raf = false;
  function schedule() {
    if (raf) return;
    raf = true;
    requestAnimationFrame(() => { raf = false; try { applyAll(); } catch (_) {} });
  }

  function startObserver() {
    const container = document.getElementById('messages') || document.body;
    if (observer) return true;
    observer = new MutationObserver(schedule);
    observer.observe(container, { childList: true, subtree: true });
    return true;
  }

  function install(attempt) {
    attempt = attempt || 0;
    if (document.getElementById('messages') || document.querySelector('.role-icon.assistant')) {
      startObserver();
      applyAll();
      window.HermesCustomAvatarExtension = {
        version: '0.1.0',
        get: getAvatar,
        set: (dataUrl) => { if (isDataImage(dataUrl)) setAvatar(dataUrl); return getAvatar(); },
        clear: () => setAvatar(''),
        refresh: applyAll,
      };
      return true;
    }
    if (attempt < 80) { setTimeout(() => install(attempt + 1), 150); return false; }
    console.warn('[' + EXT + '] messages container not found; not installed');
    return false;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => install(), { once: true });
  } else {
    install();
  }
})();
