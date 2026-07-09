// Diamond Access AI — Content Script
// Phase A: skeleton — log injection, send PAGE_LOAD once
// Phase D: ACTIVATE handler — push-to-talk voice loop
// Phase E: Command integration — full round-trip: listen → DOM walk → LLM → speak → action
// Phase F: Action execution — real click/navigate/fill/confirm via actions.ts

import { defineContentScript } from 'wxt/utils/define-content-script';
import {
  playBeep,
  speak,
  startListening,
  isListening,
  resetSleepTimer,
} from '../lib/voice';
import { buildPageSnapshot, isSparseDOM } from '../lib/page-snapshot';
import {
  executeAction,
  checkConfirmation,
  hasPendingConfirm,
  type DiamondAction,
} from '../lib/actions';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** True while a COMMAND round-trip is in flight — prevents overlapping. */
let isProcessing = false;

/** Elements from the last buildPageSnapshot call (for action resolution). */
let lastSnapshot = buildPageSnapshot();

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    console.log('Diamond Access AI content script loaded');

    const url =
      typeof window !== 'undefined' && typeof window.location !== 'undefined'
        ? window.location.href
        : '';
    if (!url) return;

    // PAGE_LOAD: build snapshot and send to background for auto-summary
    const snap = buildPageSnapshot();
    lastSnapshot = snap;

    chrome.runtime
      .sendMessage({
        type: 'PAGE_LOAD',
        url,
        structure: snap.structure,
      })
      .then((response) => {
        const resp = response as { summary?: string } | undefined;
        if (resp?.summary) {
          speak(resp.summary);
        }
      })
      .catch(() => {
        // Service worker may not be awake — silent fallback
      });

    // Phase D/E/F: listen for Alt+D activation from the service worker
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
 * Activate Diamond: awake beep → listen → (confirm?) → DOM walk → LLM → speak → action.
 *
 * Phase F adds confirmation-flow check at the top: if there's a pending
 * confirmation, a simple "yes" / "confirm" executes the pending action
 * without going through the LLM.
 *
 * Guarded by isListening() (Phase D) and isProcessing (Phase E) to prevent
 * double-activation and overlapping round-trips.
 */
async function activateDiamond(): Promise<void> {
  // Guard: not already listening and not already processing a command
  if (isListening() || isProcessing) return;

  playBeep('awake');
  resetSleepTimer();

  const transcript = await startListening();
  resetSleepTimer();

  if (!transcript) {
    await speak("I didn't hear anything.");
    return;
  }

  console.log('[Diamond] transcript:', transcript);

  // ── Phase F: Check if this is a confirmation response ─────────────────
  if (hasPendingConfirm()) {
    const confirmResult = checkConfirmation(transcript);

    if (confirmResult.isConfirm && confirmResult.action) {
      // User confirmed — execute the pending action
      const snap = buildPageSnapshot();
      lastSnapshot = snap;
      const result = await executeAction(confirmResult.action, snap);
      if (result) await speak(result);
      return;
    }

    if (confirmResult.hadPending) {
      // User cancelled the pending action
      await speak('Action cancelled.');
      // Fall through to normal command flow
    }
  }

  // ── Normal command flow ────────────────────────────────────────────────
  isProcessing = true;
  try {
    const snap = buildPageSnapshot();
    lastSnapshot = snap;

    let pageContext = snap.structure;

    // Check if DOM is too sparse — request VLM fallback
    if (isSparseDOM()) {
      try {
        const vlmResponse = await chrome.runtime.sendMessage({
          type: 'VLM_REQUEST',
        });
        const vlmResp = vlmResponse as { description?: string } | undefined;
        if (vlmResp?.description) {
          pageContext = `Visual context: ${vlmResp.description}\n\nDOM structure:\n${snap.structure}`;
          await speak('Analyzing page visually...');
        }
      } catch {
        // VLM unavailable — proceed with text-only structure
      }
    }

    // --- Send COMMAND to service worker ---
    const response = await chrome.runtime.sendMessage({
      type: 'COMMAND',
      transcript,
      pageStructure: pageContext,
      url: window.location.href,
    });

    const rawResponse =
      typeof response === 'string'
        ? response
        : (response as { text?: string })?.text ?? '';

    if (!rawResponse) {
      await speak("I couldn't process that. Please try again.");
      return;
    }

    // --- Parse and execute response ---
    await handleResponse(rawResponse, snap);
  } catch (e: unknown) {
    const errMsg = String(e);
    if (
      errMsg.includes('message channel closed') ||
      errMsg.includes('receiving end does not exist')
    ) {
      await speak('The AI service is temporarily unavailable.');
    } else {
      console.error('[Diamond] command error:', e);
      await speak('Something went wrong. Please try again.');
    }
  } finally {
    isProcessing = false;
  }
}

// ---------------------------------------------------------------------------
// Response handling
// ---------------------------------------------------------------------------

/**
 * Parse the LLM response and execute the appropriate action.
 *
 * Tries JSON.parse first. If the response is valid JSON matching one of the
 * known action schemas, the action is dispatched to executeAction.
 * Otherwise, the response is treated as plain speech and spoken aloud.
 *
 * @param rawText - Raw response text from the LLM
 * @param snapshot - PageSnapshot for element resolution in actions
 */
async function handleResponse(
  rawText: string,
  snapshot: import('../lib/page-snapshot').PageSnapshot,
): Promise<void> {
  const trimmed = rawText.trim();

  // Try to parse as JSON action
  let action: DiamondAction | null = null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (isValidAction(parsed)) {
      action = parsed as unknown as DiamondAction;
    }
  } catch {
    // Not valid JSON — treat as plain speech
  }

  if (!action) {
    // Plain speech response
    await speak(trimmed);
    return;
  }

  // Execute via the actions module (Phase F)
  try {
    const result = await executeAction(action, snapshot);
    if (result) {
      await speak(result);
    }
  } catch {
    await speak(
      'Something went wrong executing that action. Try again.',
    );
  }
}

// ---------------------------------------------------------------------------
// Action validation
// ---------------------------------------------------------------------------

/**
 * Minimal schema check — verifies the parsed object matches one of the
 * known action shapes. Covers the five schemas from the system prompt.
 */
function isValidAction(obj: Record<string, unknown>): boolean {
  if (typeof obj.action !== 'string') return false;

  switch (obj.action) {
    case 'none':
      return typeof obj.speech === 'string';

    case 'navigate':
      return typeof obj.url === 'string' && typeof obj.description === 'string';

    case 'click':
      return (
        typeof obj.elementIndex === 'number' &&
        typeof obj.description === 'string'
      );

    case 'fill':
      return (
        Array.isArray(obj.fields) &&
        obj.fields.length > 0 &&
        typeof obj.description === 'string'
      );

    case 'confirm':
      return (
        typeof obj.speech === 'string' &&
        obj.pendingAction !== null &&
        typeof obj.pendingAction === 'object'
      );

    default:
      return false;
  }
}
