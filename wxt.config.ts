import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  name: 'Diamond Access AI',
  version: '0.1.0',
  description:
    'Voice-first browser accessibility assistant powered by AI on AMD GPUs',
  manifest: {
    name: 'Diamond Access AI',
    default_locale: 'en',
    // 'tabs' lets chrome.tabs.captureVisibleTab() work from the service
    // worker on any user-active tab. Without it the SW relies on activeTab
    // short-lived grant inheriting through the content-script keydown
    // gesture, which can drop in some Chrome MV3 states. Source-wise
    // minimal: we never enumerate or modify tabs, only capture pixels.
    permissions: ['activeTab', 'storage', 'tabs'],
    // Phase A gap-fix: declare the options page so Chrome surfaces it in
    // the right-click menu and `chrome://extensions` → Details → Options.
    // `open_in_tab: true` matches the existing full-page UX (the script
    // builds its own DOM and appends to document.body).
    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },
    action: {
      default_title: 'Diamond Access AI — Press Ctrl+Shift+D to activate',
      // Phase J: extension popup exposes activation mode + settings link.
      // Caretakers can flip command/hands-free mode without keyboard,
      // and reach the Options page (API key) without chrome://extensions.
      // CSP note: popup refers to public/popup-page.js via <script src>,
      // which is allowed under MV3 default `script-src 'self'`.
      default_popup: 'popup.html',
    },
    commands: {
      'activate-diamond': {
        suggested_key: { default: 'Ctrl+Shift+D' },
        description: 'Activate Diamond listening',
      },
      'activate-diamond-alt': {
        suggested_key: { default: 'Alt+Shift+D' },
        description:
          'Activate Diamond (alt — use if primary conflicts)',
      },
      'toggle-diamond-mode': {
        // Phase J: Alt+S flips activation mode between Command (push-to-
        // talk) and Hands-Free (continuous STT). Universal toggle key
        // that doesn't conflict with browser reserved shortcuts.
        suggested_key: { default: 'Alt+S' },
        description:
          'Toggle Diamond activation mode (Command <-> Hands-Free)',
      },
    },
    icons: {
      16: 'icons/icon16.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
  }
});
