/* RSS Feeds — frontend injector (self-contained WebUI extension).
   Builds a two-pane overlay with the exact DOM ids feeds.js needs, adds a
   titlebar launcher (left-rail launcher on the redesigned banner-less homepage,
   where the titlebar is collapsed to height:0), and grants sidecar-proxy
   consent so feeds.js's repointed /api/extensions/rss-feeds/sidecar/* calls
   reach the loopback feeds backend.
   No index.html edits, no fork coupling — survives upstream updates. */
(function () {
  'use strict';
  if (window.__rssFeeds) return; window.__rssFeeds = true;
  var EXT = 'rss-feeds';

  // ── i18n (en / zh) ───────────────────────────────────────────────────────
  // This script loads before feeds.js, so it carries its own small table
  // rather than depending on the other file's namespace. Locale is read live
  // from <html lang> / localStorage 'hermes-lang' on every lookup.
  var RSS_INJECT_I18N = (function () {
    var STR = {
      en: {
        feedsLabel: 'Feeds',
        search: 'Search',
        filters: 'Filters',
        showFilters: 'Show filters',
        settings: 'Settings',
        rssSettings: 'RSS settings',
        addFeed: 'Add feed',
        refreshAll: 'Refresh all',
        refreshAllFeeds: 'Refresh all feeds',
        refreshNow: 'Refresh now',
        refreshFeeds: 'Refresh feeds',
        loading: 'Loading…',
        autoRefreshCountdown: 'Auto-refresh countdown',
        scrollTop: 'Scroll to top',
        top: 'Top',
        scrollBottom: 'Scroll to bottom',
        bottom: 'Bottom',
        selectFeed: 'Select a feed',
        selectFeedSub: 'Pick a feed from the sidebar to read its entries. Tap <strong>+</strong> to add one.',
        allFeeds: 'All feeds',
        clickedArticles: 'Clicked articles',
        summaries: 'Summaries',
        close: 'Close',
        menu: 'Menu',
        openFeeds: 'Open Feeds',
        approvalNeeded: 'Approval needed',
        approvalNoPassword: 'The RSS Feeds sidecar is blocked while Desktop has no password. Enable <strong>Settings → Password</strong>, then approve the sidecar under <strong>Settings → Extensions</strong>, then reopen.',
        approvalSidecar: 'Approve the RSS Feeds sidecar under <strong>Settings → Extensions</strong>, then reopen.',
      },
      zh: {
        feedsLabel: '订阅源',
        search: '搜索',
        filters: '过滤',
        showFilters: '显示过滤',
        settings: '设置',
        rssSettings: 'RSS 设置',
        addFeed: '添加订阅源',
        refreshAll: '全部刷新',
        refreshAllFeeds: '刷新所有订阅源',
        refreshNow: '立即刷新',
        refreshFeeds: '刷新订阅源',
        loading: '加载中…',
        autoRefreshCountdown: '自动刷新倒计时',
        scrollTop: '滚动到顶部',
        top: '顶部',
        scrollBottom: '滚动到底部',
        bottom: '底部',
        selectFeed: '选择一个订阅源',
        selectFeedSub: '从侧边栏选择一个订阅源来阅读条目。点击 <strong>+</strong> 添加。',
        allFeeds: '全部订阅源',
        clickedArticles: '已点击文章',
        summaries: '摘要',
        close: '关闭',
        menu: '菜单',
        openFeeds: '打开订阅源',
        approvalNeeded: '需要授权',
        approvalNoPassword: 'Desktop 未设置密码，RSS Feeds sidecar 已被阻止。请先在<strong>设置 → 密码</strong>中启用密码，然后在<strong>设置 → 扩展</strong>中批准该 sidecar，再重新打开。',
        approvalSidecar: '请在<strong>设置 → 扩展</strong>中批准 RSS Feeds sidecar，然后重新打开。',
      },
    };
    function isZh() {
      var v = '';
      try { v = String(document.documentElement.lang || ''); } catch (_) {}
      if (!/^zh/i.test(v)) {
        try { v = String(localStorage.getItem('hermes-lang') || ''); } catch (_) {}
      }
      return /^zh/i.test(v);
    }
    function t(key) {
      var table = isZh() ? STR.zh : STR.en;
      return (table && table[key]) || STR.en[key] || key;
    }
    return { t: t };
  })();
  function ti(key) { return RSS_INJECT_I18N.t(key); }

  var SIDEBAR_INNER = `      <div class="panel-head">
        <span>${ti('feedsLabel')}</span>
        <div class="panel-head-actions">
          <button class="panel-head-btn has-tooltip has-tooltip--bottom" id="feedsSearchBtnD" onclick="mcToggleSearchBar()" data-tooltip="${ti('search')}" aria-label="${ti('search')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button>
          <button class="panel-head-btn has-tooltip has-tooltip--bottom" id="feedsToolsBtnD" onclick="mcToggleMobileTools()" data-tooltip="${ti('filters')}" aria-label="${ti('showFilters')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg></button>
          <button class="panel-head-btn has-tooltip has-tooltip--bottom" id="feedsGearBtnD" onclick="mcOpenFeedSettings(event)" data-tooltip="${ti('settings')}" aria-label="${ti('rssSettings')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
          <button class="panel-head-btn has-tooltip has-tooltip--bottom" id="feedsAddBtn" onclick="mcOpenAddFeed()" data-tooltip="${ti('addFeed')}" aria-label="${ti('addFeed')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
          <button class="panel-head-btn has-tooltip has-tooltip--bottom" id="feedsRefreshBtn" onclick="mcRefreshAllFeeds()" data-tooltip="${ti('refreshAll')}" aria-label="${ti('refreshAllFeeds')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
        </div>
      </div>
      <div style="flex:1;overflow-y:auto;padding:8px" id="feedsListSidebar"><div style="color:var(--muted);font-size:12px">${ti('loading')}</div></div>`;
  var MAIN_INNER = `      <div class="main-view-header">
        <div class="main-view-title" id="feedsViewTitle">${ti('feedsLabel')}</div>
        <div class="main-view-actions">
          <span class="mc-feeds-timer mc-feeds-timer-top" id="feedsTimerTop" data-feed-timer hidden title="${ti('autoRefreshCountdown')}"></span>
          <button class="panel-head-btn has-tooltip has-tooltip--bottom" id="feedsSettingsBtn" onclick="mcOpenFeedSettings(event)" data-tooltip="${ti('settings')}" aria-label="${ti('rssSettings')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
          <button class="panel-head-btn has-tooltip has-tooltip--bottom" id="feedsRefreshHeadBtn" onclick="mcRefreshAllFeeds()" data-tooltip="${ti('refreshNow')}" aria-label="${ti('refreshFeeds')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
                  </div>
      </div>
      <div class="main-view-body" id="feedsViewBody" style="overflow-y:auto;padding:14px"></div>
      <!-- jump arrows for the feeds pane — ↑ anchored top, ↓ anchored bottom (responsive, touch-friendly) -->
      <button type="button" class="feeds-scroll-btn feeds-scroll-btn--top" id="feedsScrollTopBtn" onclick="mcFeedsScrollTop()" aria-label="${ti('scrollTop')}" title="${ti('top')}" style="display:none"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg></button>
      <button type="button" class="feeds-scroll-btn feeds-scroll-btn--bottom" id="feedsScrollBottomBtn" onclick="mcFeedsScrollBottom()" aria-label="${ti('scrollBottom')}" title="${ti('bottom')}" style="display:none"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg></button>
      <div class="main-view-empty" id="feedsViewEmpty">
        <svg class="main-view-empty-icon" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg>
        <div class="main-view-empty-title">${ti('selectFeed')}</div>
        <div class="main-view-empty-sub">${ti('selectFeedSub')}</div>
      </div>`;

  // Consent is granted by the user in Settings -> Extensions; we NEVER auto-grant
  // it. Core reports sidecar consent under TOP-LEVEL `status.sidecars` (an array of
  // {id, proxy:{consented, posture}}). Resolve {consented, posture}, matching our
  // record by id. FAIL CLOSED (consented:false) when the record is absent so a
  // shape/label mismatch can't make an un-approved sidecar look consented.
  function sidecarStatus() {
    return fetch('/api/extensions/status', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var list = (d && Array.isArray(d.sidecars)) ? d.sidecars : [];
        var me = null;
        for (var i = 0; i < list.length; i++) { if (list[i] && list[i].id === EXT) { me = list[i]; break; } }
        if (!me) return { consented: false, posture: '', found: false };
        var p = me.proxy || {};
        return { consented: p.consented === true, posture: p.posture || '', found: true };
      }).catch(function () { return { consented: false, posture: '', found: false }; });
  }

  function buildOverlay() {
    if (document.getElementById('hxFeedsOverlay')) return;
    if (!document.body) return;
    var ov = document.createElement('div');
    ov.id = 'hxFeedsOverlay';
    ov.className = 'hx-feeds-overlay';
    ov.style.display = 'none';
    ov.innerHTML =
      '<div class="hx-feeds-card" role="dialog" aria-modal="true" aria-label="' + ti('feedsLabel') + '" tabindex="-1">' +
        '<div class="hx-feeds-topbar">' +
          '<span class="hx-feeds-brand">' +
            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg>' +
            '<span id="hxFeedsBrandLabel"> ' + ti('feedsLabel') + '</span>' +
            '<span class="hx-feeds-brand-title" id="hxFeedsBrandTitle"></span></span>' +
          // Topbar actions. The "movable" group (search, filter, all-feeds,
          // clicked, summaries, gear) sits inline on desktop but relocates to a
          // bottom-right thumb cluster on mobile (via CSS). Add + Refresh + Close
          // always stay in the top bar.
          '<span class="hx-feeds-topbar-actions">' +
            '<span class="hx-feeds-actions-move" id="hxFeedsActionsMove">' +
              '<button type="button" class="panel-head-btn has-tooltip has-tooltip--bottom" id="feedsSearchBtn" onclick="mcToggleSearchBar()" data-tooltip="' + ti('search') + '" aria-label="' + ti('search') + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button>' +
              '<button type="button" class="panel-head-btn has-tooltip has-tooltip--bottom" id="feedsToolsBtn" onclick="mcToggleMobileTools()" data-tooltip="' + ti('filters') + '" aria-label="' + ti('filters') + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg></button>' +
              '<button type="button" class="panel-head-btn has-tooltip has-tooltip--bottom" id="feedsAllBtn" onclick="mcSelectFeed(null)" data-tooltip="' + ti('allFeeds') + '" aria-label="' + ti('allFeeds') + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></button>' +
              '<button type="button" class="panel-head-btn has-tooltip has-tooltip--bottom" id="feedsClickedBtnM" onclick="mcSelectRead()" data-tooltip="' + ti('clickedArticles') + '" aria-label="' + ti('clickedArticles') + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg></button>' +
              '<button type="button" class="panel-head-btn has-tooltip has-tooltip--bottom" id="feedsSummariesBtnM" onclick="mcSelectSummaries()" data-tooltip="' + ti('summaries') + '" aria-label="' + ti('summaries') + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.4L22 18.3l-2.1.9L19 21l-.9-1.8-2.1-.9 2.1-.9z"/></svg></button>' +
              '<button type="button" class="panel-head-btn has-tooltip has-tooltip--bottom" id="feedsGearBtnM" onclick="mcOpenFeedSettings(event)" data-tooltip="' + ti('settings') + '" aria-label="' + ti('rssSettings') + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>' +
            '</span>' +
            '<span class="hx-feeds-nav-slot" id="hxFeedsNavSlot"></span>' +
            '<button type="button" class="panel-head-btn has-tooltip has-tooltip--bottom" id="feedsAddBtnM" onclick="mcOpenAddFeed()" data-tooltip="' + ti('addFeed') + '" aria-label="' + ti('addFeed') + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>' +
            '<button type="button" class="panel-head-btn has-tooltip has-tooltip--bottom" id="feedsRefreshBtnM" onclick="mcRefreshAllFeeds()" data-tooltip="' + ti('refreshAll') + '" aria-label="' + ti('refreshAllFeeds') + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>' +
          '</span>' +
          '<button type="button" class="hx-feeds-close" id="hxFeedsClose" aria-label="' + ti('close') + '">&times;</button>' +
        '</div>' +
        '<div class="hx-feeds-body">' +
          '<div class="panel-view hx-feeds-sidebar" id="panelFeeds">' + SIDEBAR_INNER + '</div>' +
          '<div id="mainFeeds" class="main-view hx-feeds-main">' + MAIN_INNER + '</div>' +
        '</div>' +
        // Floating burger (mobile) — toggles the action menu on pages that have
        // no bottom controls bar (Summaries / Clicked). On grouped pages a burger
        // lives in the Expand/Collapse/Filter bar instead (this one hides).
        '<button type="button" class="hx-feeds-burger hx-feeds-burger-fab" id="hxFeedsBurgerFab" onclick="mcToggleActionMenu()" aria-label="' + ti('menu') + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></button>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) closeOverlay(); });
    var c = document.getElementById('hxFeedsClose');
    if (c) c.addEventListener('click', closeOverlay);
    // Auto-close the burger menu once any action icon inside it is tapped.
    var moveGroup = document.getElementById('hxFeedsActionsMove');
    if (moveGroup) moveGroup.addEventListener('click', function (e) {
      if (e.target.closest('button') && typeof window.mcCloseActionMenu === 'function') {
        setTimeout(window.mcCloseActionMenu, 0);
      }
    });
    // Capture-phase so we CONSUME Escape before host handlers underneath (which
    // would otherwise also close Settings/search/dropdowns beneath the overlay).
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || ov.style.display === 'none') return;
      e.preventDefault();
      e.stopPropagation();
      // Peel the frontmost body-mounted popup first; only close the overlay
      // itself once nothing is stacked above it.
      if (window.mcFeedsDismissTopPopup && window.mcFeedsDismissTopPopup()) return;
      closeOverlay();
    }, true);
  }

  var _lastFocus = null;
  function openOverlay() {
    buildOverlay();
    var ov = document.getElementById('hxFeedsOverlay');
    if (ov) ov.style.display = 'flex';
    // Remember what had focus so we can restore it on close, then move initial
    // focus into the dialog (accessibility: a modal should own focus).
    _lastFocus = document.activeElement;
    var card = ov && ov.querySelector('.hx-feeds-card');
    if (card) { try { card.focus(); } catch (_) {} }
    sidecarStatus().then(function (st) {
      var body = document.getElementById('feedsViewBody');
      // token-v1 fails closed with 403 while WebUI auth is off (posture
      // "local_unprotected"), so proxied calls would fail even if consented \u2014
      // name the full remedy: turn on a password FIRST, then approve.
      if (st.posture === 'local_unprotected') {
        if (body) body.innerHTML = '<div class="main-view-empty"><div class="main-view-empty-title">' + ti('approvalNeeded') + '</div><div class="main-view-empty-sub">' + ti('approvalNoPassword') + '</div></div>';
        return;
      }
      if (!st.consented) {
        if (body) body.innerHTML = '<div class="main-view-empty"><div class="main-view-empty-title">' + ti('approvalNeeded') + '</div><div class="main-view-empty-sub">' + ti('approvalSidecar') + '</div></div>';
        return;
      }
      if (typeof window.mcLoadFeedsPanel === 'function') { try { window.mcLoadFeedsPanel(); } catch (_) {} }
    });
  }
  function closeOverlay() {
    if (window.mcFeedsTeardownPopups) window.mcFeedsTeardownPopups();
    // Stop the countdown/observe timer so it isn't left polling while hidden.
    if (window.mcFeedsStopTimer) window.mcFeedsStopTimer();
    var ov = document.getElementById('hxFeedsOverlay');
    if (ov) ov.style.display = 'none';
    // Restore focus to wherever it was (the launcher), not left on a now-hidden
    // element — falls back to the launcher button explicitly.
    var back = _lastFocus || document.getElementById('hxFeedsLauncher');
    if (back && typeof back.focus === 'function') { try { back.focus(); } catch (_) {} }
    _lastFocus = null;
  }
  window.hxOpenFeeds = openOverlay;
  window.hxCloseFeeds = closeOverlay;

  // Classic WebUI renders the titlebar (banner) with real height. The
  // redesigned banner-less homepage collapses .app-titlebar to height:0 with
  // overflow:visible + pointer-events:none and hides #btnReload — a button
  // appended there floats offset over the content and can't be clicked, so we
  // mount into the left rail instead (core's .rail-btn styles it and it stays
  // visible on every panel — same pattern as external-app-tab).
  function titlebarUsable() {
    var t = document.querySelector('.app-titlebar');
    if (!t) return false;
    if (window.getComputedStyle(t).display === 'none') return false;
    return t.getBoundingClientRect().height > 2;
  }

  function addLauncher() {
    if (document.getElementById('hxFeedsLauncher')) return;
    var btn = document.createElement('button');
    btn.id = 'hxFeedsLauncher';
    btn.type = 'button';
    // Host replaced native tooltips (#1775) — use its has-tooltip convention,
    // not a native title=.
    btn.setAttribute('data-tooltip', ti('feedsLabel'));
    btn.setAttribute('aria-label', ti('openFeeds'));
    btn.addEventListener('click', openOverlay);
    if (titlebarUsable()) {
      btn.className = 'hx-feeds-launcher has-tooltip has-tooltip--bottom';
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg>';
      document.querySelector('.app-titlebar').appendChild(btn);
      return;
    }
    var rail = document.querySelector('.rail');
    if (!rail) {
      // Pre-redesign fallback chain for hosts without a titlebar element.
      var host = document.querySelector('header') || document.body;
      btn.className = 'hx-feeds-launcher has-tooltip has-tooltip--bottom';
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg>';
      host.appendChild(btn);
      return;
    }
    btn.className = 'rail-btn nav-tab has-tooltip hx-feeds-rail';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg>';
    // Sit with the content tabs, just above the rail spacer / settings.
    var spacer = rail.querySelector('.rail-spacer');
    if (spacer) rail.insertBefore(btn, spacer);
    else rail.appendChild(btn);
  }

  function init() { buildOverlay(); addLauncher(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
