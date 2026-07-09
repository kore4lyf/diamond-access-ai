// Diamond Access AI — Content Script
// Phase A: skeleton — log injection, send PAGE_LOAD once
// Phase D: ACTIVATE handler — push-to-talk voice loop
// Phase D: Alt+D `keydown` listener (content-script fallback for
//          PC-D-4 — Chrome strips Alt+D from `chrome.commands` because
//          the browser reserves it for the omnibox focus shortcut).
// Phase E: Command integration — full round-trip: listen → DOM walk → LLM → speak → action
// Phase F: Action execution — real click/navigate/fill/confirm via actions.ts
// Phase H: Safety-net wrap + ERRORS-only strings + latency logging

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
import { wrapIrreversible } from '../lib/safety-net';
import { ERRORS } from '../lib/errors';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** True while a COMMAND round-trip is in flight — prevents overlapping. */
let isProcessing = false;

// ---------------------------------------------------------------------------
// Activation-route state
// ---------------------------------------------------------------------------
/**
 * Tracks where the next `activateDiamond()` invocation came from so the
 * confirmation/early-return paths can end timers symmetrically.
 *
 * Sources:
 *   'sw'    — Chrome `commands.onCommand` (Ctrl+Shift+D, Alt+Shift+D)
 *   'kbd'   — Content-script `keydown` (Alt+D, the primary UX shortcut)
 */
type ActivationSource = 'sw' | 'kbd';
let lastActivationSource: ActivationSource = 'sw';

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

    // Phase D/E/F: listen for `ACTIVATE` from the service worker
    // (triggered by chrome.commands.onCommand for Ctrl+Shift+D / Alt+Shift+D).
    chrome.runtime.onMessage.addListener((message) => {
      const msg = message as { type?: string };
      if (msg.type === 'ACTIVATE') {
        lastActivationSource = 'sw';
        activateDiamond();
      }
    });

    // Phase D: Alt+D local keydown — the user's *primary* shortcut.
    // Chrome's `commands` manifest binding can't carry Alt+D (the browser
    // reserves that key for the omnibox focus shortcut), so we capture it
    // here, preventDefault to stop the omnibox steal, and route to
    // activateDiamond() — same code path as CTRL+Shift+D.
    //
    // Guard rules (PC-D-4):
    //   - `e.code === 'KeyD'` — locale-independent (e.key would be 'd' etc.)
    //   - `e.altKey === true`  — Alt must be held
    //   - `!e.shiftKey`        — modifier exclusivity vs. Alt+Shift+D fallback
    //   - `!e.ctrlKey && !e.metaKey` — avoid clobbering Ctrl+Alt+D / Cmd+Alt+D
    //   - `!e.repeat`          — ignore OS key-repeat double-fire
    //   - target is NOT a form field / contentEditable — never steal typing
    window.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        if (
          e.code !== 'KeyD' ||
          !e.altKey ||
          e.shiftKey ||
          e.ctrlKey ||
          e.metaKey ||
          e.repeat
        ) {
          return;
        }
        const target = e.target;
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          (target instanceof HTMLElement && target.isContentEditable)
        ) {
          return; // user is typing — don't interrupt.
        }
        e.preventDefault();
        e.stopPropagation();
        lastActivationSource = 'kbd';
        activateDiamond();
      },
      true, // capture phase so we beat page-level handlers
    );
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

  console.time('diamond-command');

  playBeep('awake');
  resetSleepTimer();

  console.time('diamond-stt');
  const transcript = await startListening();
  console.timeEnd('diamond-stt');
  resetSleepTimer();

  if (!transcript) {
    // Per ERRORS.STT_NO_SPEECH: silence on no-speech. The constant is
    // intentionally empty — don't fall back to a spoken message which
    // would defeat the design.
    console.timeEnd('diamond-command');
    await speak(ERRORS.STT_NO_SPEECH);
    return;
  }

  console.log('[Diamond] transcript:', transcript);

  // ── Phase F: Check if this is a confirmation response ─────────────────
  if (hasPendingConfirm()) {
    const confirmResult = checkConfirmation(transcript);

    if (confirmResult.isConfirm && confirmResult.action) {
      // User confirmed — execute the pending action.
      // End diamond-command here: this branch returns BEFORE the
      // try/finally block below, so without this timeEnd we'd leak a
      // "Timer started but never ended" console warning on every confirm.
      console.timeEnd('diamond-command');
      const snap = buildPageSnapshot();
      const result = await executeAction(confirmResult.action, snap);
      if (result) await speak(result);
      return;
    }

    if (confirmResult.hadPending) {
      // User cancelled the pending action — fall through to normal flow
      await speak(ERRORS.ACTION_CANCELLED);
    }
  }

  // ── Normal command flow ────────────────────────────────────────────────
  isProcessing = true;
  try {
    const snap = buildPageSnapshot();

    console.time('diamond-vlm');
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
    console.timeEnd('diamond-vlm');

    // --- Send COMMAND to service worker ---
    console.time('diamond-llm');
    const response = await chrome.runtime.sendMessage({
      type: 'COMMAND',
      transcript,
      pageStructure: pageContext,
      url: window.location.href,
    });
    console.timeEnd('diamond-llm');

    const rawResponse =
      typeof response === 'string'
        ? response
        : (response as { text?: string })?.text ?? '';

    if (!rawResponse) {
      // End diamond-command here. This branch returns BEFORE the
      // finally block, so omitting this would leak a "Timer started
      // but never ended" console warning.
      console.timeEnd('diamond-command');
      await speak(ERRORS.EMPTY_RESPONSE);
      return;
    }

    // --- Parse and execute response ---
    console.time('diamond-action');
    await handleResponse(rawResponse, snap);
    console.timeEnd('diamond-action');
  } catch (e: unknown) {
    const errMsg = String(e);
    if (
      errMsg.includes('message channel closed') ||
      errMsg.includes('receiving end does not exist')
    ) {
      await speak(ERRORS.SW_TERMINATED);
    } else {
      console.error('[Diamond] command error:', e);
      await speak(ERRORS.AI_UNAVAILABLE);
    }
  } finally {
    console.timeEnd('diamond-command');
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
    // Plain speech response -- handleResponse owns the diamond-action
    // timer (set by activateDiamond's `console.time('diamond-action')`
    // immediately before calling us), so this branch only needs to
    // return. The activated timer ends cleanly in activateDiamond.
    await speak(trimmed);
    return;
  }

  // ── Phase H: Safety net — check for irreversible actions ──────────────
  const elementText = getElementText(action, snapshot);
  const safeAction = wrapIrreversible(action, elementText);

  // Execute via the actions module (Phase F/H)
  try {
    const result = await executeAction(safeAction, snapshot);
    if (result) {
      await speak(result);
    }
  } catch {
    await speak(ERRORS.SOMETHING_WRONG);
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

// ---------------------------------------------------------------------------
// Safety-net helpers
// ---------------------------------------------------------------------------

/**
 * Extract the element's text/description from the snapshot for the
 * safety-net keyword check.
 *
 * Tries, in order:
 *   1. The element's textContent / innerText / aria-label from the snapshot
 *   2. The action's description field
 *   3. Empty string (no match possible — passes through safely)
 */
function getElementText(
  action: DiamondAction,
  snapshot: import('../lib/page-snapshot').PageSnapshot,
): string {
  if (action.action === 'click') {
    const idx = action.elementIndex - 1;
    const el = snapshot.elements[idx];
    if (el) {
      const text =
        el.textContent?.trim() ||
        (el as HTMLElement).innerText?.trim() ||
        el.getAttribute('aria-label') ||
        '';
      if (text) return text;
    }

    // Fallback to the description from the action
    if (action.description) return action.description;
  }

  return '';
}
