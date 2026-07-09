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
    permissions: ['activeTab', 'storage'],
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
    },
    icons: {
      16: 'icons/icon16.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
  }
});
