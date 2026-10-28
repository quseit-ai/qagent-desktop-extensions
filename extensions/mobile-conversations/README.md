# Mobile Conversations Button

Mobile Conversations Button is a trusted local Desktop extension that adds
a phone-only floating **Conversations** button near the chat composer. It opens
the existing mobile conversations drawer, then stays in the same floating
position as an **X** above the open drawer so it can be closed again. It also
provides a long-press shortcuts menu for common conversation navigation actions.

## 中文说明

本扩展在手机宽度下为聊天界面添加一个浮动的「对话」按钮：轻点打开现有的
移动端对话侧边栏，侧边栏打开后按钮停留在原位并变成关闭（X）图标；长按
可打开快捷菜单，包含新建对话、打开侧边栏、回到顶部、跳到最新消息。
桌面宽度下界面保持不变。界面文案会跟随 Desktop 的语言设置，简体中文环境
下自动显示中文。

## What It Does

- Adds a phone-width-only floating Conversations button inside the chat messages
  shell.
- Short tap opens the existing mobile conversations/sidebar drawer.
- Long press opens a menu with shortcuts for:
  - New conversation
  - Open sidebar
  - Go to top
  - Go to last message
- Keeps the same button in its normal floating position above the open mobile drawer as an **X** close affordance.
- Leaves desktop-width layouts unchanged.

## Current Shape

```text
Desktop page
  -> manifest-bundled extension assets
  -> /extensions/assets/mobile-conversations.js
  -> /extensions/assets/mobile-conversations.css
  -> existing Desktop mobile sidebar, session, and scroll UI hooks
```

This extension is `static-ui` / manifest-bundle only. It does not add backend
routes, start a sidecar, access external networks, read or write local files, or
use native host APIs.

## Capabilities

This entry declares only capabilities currently available to extension entries:

- `manifest-bundle`

It does not require `loopback-sidecar` or the sidecar proxy.

## Install For Local Testing

Start Desktop with this extension directory:

```bash
cd /path/to/hermes-webui
HERMES_WEBUI_EXTENSION_DIR=/path/to/hermes-webui-extensions/extensions/mobile-conversations HERMES_WEBUI_EXTENSION_MANIFEST=manifest.json ./start.sh
```

The runtime `manifest.json` injects:

```json
{
  "extensions": [
    {
      "id": "mobile-conversations",
      "name": "Mobile Conversations Button",
      "description": "Phone-only floating Conversations button and shortcut menu for Desktop.",
      "scripts": ["assets/mobile-conversations.js"],
      "stylesheets": ["assets/mobile-conversations.css"]
    }
  ]
}
```

## Disable And Uninstall

To disable the Desktop extension, restart Desktop without:

```text
HERMES_WEBUI_EXTENSION_DIR
HERMES_WEBUI_EXTENSION_MANIFEST
HERMES_WEBUI_EXTENSION_STYLESHEET_URLS
HERMES_WEBUI_EXTENSION_SCRIPT_URLS
```

To uninstall it from a manual local setup, remove the
`extensions/mobile-conversations/` directory from the local extensions checkout
or remove the entry from the aggregate manifest that points at it.

## Trust And Permissions

This is trusted local code. The injected JavaScript runs in the Desktop app's
browser origin and can use the logged-in browser session.

Current disclosed behavior:

- creates extension-owned DOM for the floating button and long-press menu
- inserts the floating button into the existing `.messages-shell` and temporarily reparents it to `document.body` while the mobile drawer is open so it can sit above the drawer at the same visual position
- reads existing mobile layout state through Desktop DOM/classes
- calls existing Desktop browser functions when available, including
  `switchPanel`, `closeMobileSidebar`, `newSession`, `renderSessionList`,
  `jumpToSessionStart`, and `scrollToBottom`
- toggles existing mobile sidebar classes as a fallback when the public browser
  helper is unavailable
- swaps its icon between the conversations glyph and a close X based on the mobile sidebar state
- uses pointer, context-menu, keyboard, resize, scroll, and mutation-observer
  handlers for mobile interaction and accessibility behavior
- does not call Desktop HTTP APIs
- does not use localStorage or sessionStorage
- does not access cookies
- does not contact loopback or external network services
- does not use arbitrary filesystem or native host APIs

## Compatibility

Required Desktop surface:

- manifest-bundled extension assets
- same-origin extension asset serving under `/extensions/`
- mobile Desktop layout with `.messages-shell`, `.sidebar`, and `#panelChat`
- existing browser hooks for mobile drawer/session/scroll behavior where
  available; the extension has DOM fallbacks for older builds

The source local extension was tested against Desktop versions at or after
`0.51.545`. The compatibility requirement is better described as the manifest
bundle plus the mobile sidebar/browser-hook surfaces listed above.

## Verification

From this repository:

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/generate-registry.mjs --out dist/registry.json
node --check extensions/mobile-conversations/assets/mobile-conversations.js
python3 -m json.tool extensions/mobile-conversations/extension.json
python3 -m json.tool extensions/mobile-conversations/manifest.json
```

Manual mobile verification should confirm:

- at phone width, the floating Conversations button appears near the lower-right
  chat controls
- tapping the button opens the existing mobile conversations drawer
- the button is hidden while the drawer is open
- long press opens the shortcuts menu
- the synthetic click after a long press does not also toggle the drawer
- the next normal tap still works
- Escape closes the shortcuts menu and returns focus to the button
- desktop-width layouts do not show the button

## Known Limitations

- The extension relies on current Desktop DOM and browser helper names until a
  formal mobile sidebar extension API exists.
- The extension is intentionally mobile-only and does not add a desktop control.
