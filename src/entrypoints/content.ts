// Diamond Access AI — Content Script
// Phase A: skeleton — log injection, send PAGE_LOAD once
// Phase B/E: DOM walk, voice, command loop

import { defineContentScript } from 'wxt/utils/define-content-script';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    console.log('Diamond Access AI content script loaded');

    // Send one PAGE_LOAD event to service worker on every page load
    // Guard against SSR / wxt prepare environment (window may be stubbed)
    const url =
      typeof window !== 'undefined' && typeof window.location !== 'undefined'
        ? window.location.href
        : '';
    if (!url) return;

    chrome.runtime.sendMessage({
      type: 'PAGE_LOAD',
      url,
    }).catch(() => {
      // Service worker may not be awake — no-op in scaffold
    });
  },
});
