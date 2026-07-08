import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  name: 'Diamond Access AI',
  version: '0.1.0',
  description:
    'Voice-first browser accessibility assistant powered by AI on AMD GPUs',
  manifest: {
    name: 'Diamond Access AI',
    permissions: ['activeTab', 'storage'],
    action: {
      default_title: 'Diamond Access AI — Press Alt+D to activate',
    },
    commands: {
      'activate-diamond': {
        suggested_key: { default: 'Alt+D' },
        description: 'Activate Diamond listening',
      },
      'activate-diamond-alt': {
        suggested_key: { default: 'Alt+Shift+D' },
        description:
          'Activate Diamond (fallback — use if Alt+D conflicts with omnibox)',
      },
    },
    icons: {
      16: 'icons/icon16.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
  }
});
