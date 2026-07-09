// Diamond Access AI — Service Worker (background)
// Phase A: skeleton — log messages, establish return-true pattern
// Phase C: Fireworks API client — FIREWORKS_TEST handler
// Phase D: chrome.commands.onCommand — Alt+D → ACTIVATE to content script
// Phase E: fetch(), captureVisibleTab(), prompt construction

import { defineBackground } from 'wxt/utils/define-background';
import { callLLM } from '../lib/fireworks';

export default defineBackground(() => {
  console.log('Diamond Access AI service worker started');

  // Phase D: Alt+D keyboard shortcut → tell the content script to wake up
  chrome.commands.onCommand.addListener(async (command) => {
    if (
      command === 'activate-diamond' ||
      command === 'activate-diamond-alt'
    ) {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'ACTIVATE' }).catch(() => {
          // Content script may not be loaded (e.g., chrome:// pages) —
          // silent fail is acceptable; Diamond simply won't activate.
        });
      }
    }
  });

  chrome.runtime.onMessage.addListener(
    (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ) => {
      const msg = message as { type?: string };
      console.log('[background] received:', msg.type ?? message);

      // Phase C: FIREWORKS_TEST — diagnostics path, triggered from SW console or
      // a future options-page "Test connection" button (Phase H polish).
      if (msg.type === 'FIREWORKS_TEST') {
        callLLM('You are a test echo.', 'Reply with the word: OK')
          .then((reply) => sendResponse({ ok: true, reply }))
          .catch((e: unknown) =>
            sendResponse({ ok: false, error: String(e) }),
          );
        return true; // keep channel open for async response
      }

      // Default: acknowledge receipt. Returning true keeps the port open until
      // sendResponse is called — critical for future async Fireworks API calls.
      sendResponse({ received: true, type: msg.type ?? 'unknown' });
      return true;
    },
  );

  chrome.action.onClicked.addListener((tab) => {
    console.log('[background] toolbar icon clicked for tab', tab.id, tab.url);
  });
});
