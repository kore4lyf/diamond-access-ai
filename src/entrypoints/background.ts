// Diamond Access AI — Service Worker (background)
// Phase A: skeleton — log messages, establish return-true pattern
// Phase C/E: fetch(), captureVisibleTab(), prompt construction

import { defineBackground } from 'wxt/utils/define-background';

export default defineBackground(() => {
  console.log('Diamond Access AI service worker started');

  chrome.runtime.onMessage.addListener(
    (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ) => {
      const msg = message as { type?: string };
      console.log('[background] received:', msg.type ?? message);

      // Acknowledge receipt. Real async handlers (COMMAND, PAGE_LOAD, VLM_REQUEST)
      // land in Phase C/E. Returning true keeps the port open until sendResponse is
      // called — critical for future async Fireworks API calls (arch §3.2).
      sendResponse({ received: true, type: msg.type ?? 'unknown' });
      return true;
    },
  );

  chrome.action.onClicked.addListener((tab) => {
    console.log('[background] toolbar icon clicked for tab', tab.id, tab.url);
  });
});
