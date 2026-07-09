// Diamond Access AI — Content Script
// Phase A: skeleton — log injection, send PAGE_LOAD once
// Phase D: ACTIVATE handler — push-to-talk voice loop
// Phase B/E: DOM walk, command integration

import { defineContentScript } from 'wxt/utils/define-content-script';
import {
  playBeep,
  speak,
  startListening,
  isListening,
  resetSleepTimer,
} from '../lib/voice';

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

    // Phase D: listen for Alt+D activation from the service worker
    chrome.runtime.onMessage.addListener((message) => {
      const msg = message as { type?: string };
      if (msg.type === 'ACTIVATE') {
        activateDiamond();
      }
    });
  },
});

// ---------------------------------------------------------------------------
// Diamond activation orchestrator
// ---------------------------------------------------------------------------

/**
 * Activate Diamond: awake beep → listen → echo back.
 *
 * Phase D:
 *   - Guards against double-activation via isListening()
 *   - Plays an awake beep so the user knows Diamond is listening
 *   - Starts STT (SpeechRecognition), waits for a transcript
 *   - Echos back what was heard as a smoke-test for the voice pipeline
 *
 * Phase E:
 *   - Will route the transcript through Fireworks (DOM walk + LLM)
 *   - Will speak the LLM's response instead of this echo
 */
async function activateDiamond(): Promise<void> {
  if (isListening()) return; // Guard: no double-activation

  playBeep('awake');
  resetSleepTimer();

  const transcript = await startListening();
  resetSleepTimer();

  console.log('[Diamond] transcript:', transcript);

  if (transcript) {
    await speak(`You said: ${transcript}`);
  } else {
    await speak("I didn't hear anything.");
  }
}
