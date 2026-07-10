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
  startHandsFree,
  stopHandsFree,
  isHandsFreeActive,
} from '../lib/voice';
import { normalizeMode, type DiamondMode } from '../lib/storage';
import { buildPageSnapshot, isSparseDOM } from '../lib/page-snapshot';
import {
  executeAction,
  checkConfirmation,
  hasPendingConfirm,
  type DiamondAction,
} from '../lib/actions';
import { wrapIrreversible } from '../lib/safety-net';
import { ERRORS } from '../lib/errors';
import * as logger from '../lib/logger';

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
    logger.debug('page_load', 'snapshot built', {
      url,
      structureLen: snap.structure.length,
      interactiveCount: snap.elements.length,
    });

    chrome.runtime
      .sendMessage({
        type: 'PAGE_LOAD',
        url,
        structure: snap.structure,
      })
      .then((response) => {
        const resp = response as { summary?: string } | undefined;
        if (resp?.summary) {
          logger.info('tts', 'PAGE_LOAD summary spoken', {
            length: resp.summary.length,
          });
          speak(resp.summary);
        }
      })
      .catch(() => {
        // Service worker may not be awake — silent fallback
      });

    // Phase D/E/F: listen for `ACTIVATE` from the service worker
    // (triggered by chrome.commands.onCommand for Ctrl+Shift+D / Alt+Shift+D).
    chrome.runtime.onMessage.addListener((message) => {
      const msg = message as { type?: string; mode?: unknown };
      if (msg.type === 'ACTIVATE') {
        lastActivationSource = 'sw';
        activateDiamond();
      }
      // Phase J: popup-toggle / voice mode switch sends broadcast.
      // Stop a running hands-free loop so the change actually takes effect
      // without requiring the user to utter something to trigger onend.
      if (msg.type === 'MODE_CHANGED') {
        const next = normalizeMode(msg.mode);
        logger.info('voice', 'MODE_CHANGED broadcast received', { mode: next });
        if (next === 'command' && isHandsFreeActive()) {
          stopHandsFree();
        }
        // Persona says "before any action, name the action in plain
        // English" — speaking the new mode name reinforces the change
        // regardless of source (popup toggle, Alt+S, or voice switch).
        // ERRORS.MODE_*_ON strings are already brief ("Hands-free mode.").
        speak(
          next === 'hands_free'
            ? ERRORS.MODE_HANDS_FREE_ON
            : ERRORS.MODE_COMMAND_ON,
        );
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

    // Phase J: Alt+S — activation-mode global toggle.
    //
    // Same capture-phase pattern as Alt+D:
    //   - locale-independent (`e.code === 'KeyS'`, not `e.key`)
    //   - modifier exclusivity (Alt only; Alt+Shift+S ignored)
    //   - ignores form fields / contentEditable (never steal typing)
    //   - preventDefault stops any browser-level handler
    //
    // Forwards as a `TOGGLE_MODE` message so the SW's `toggleModeViaStorage`
    // remains the single home for the actual flip + broadcast + speak.
    // This fallback covers `chrome://` pages, devtools, and any user
    // remap that strips `Alt+S` from the manifest binding.
    window.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        if (
          e.code !== 'KeyS' ||
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
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        chrome.runtime
          .sendMessage({ type: 'TOGGLE_MODE' })
          .catch(() => undefined);
      },
      true, // capture phase
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
 * Phase J splits this into two paths based on the persisted activation
 * mode: command (push-to-talk, existing flow) and hands_free (continuous
 * loop where each utterance goes back into listening until 60s of silence
 * or stopHandsFree).
 *
 * Guarded by isListening() (Phase D), isProcessing (Phase E), and
 * isHandsFreeActive (Phase J) to prevent double-activation and overlapping
 * round-trips.
 */
async function activateDiamond(): Promise<void> {
  // Guard: not already listening/processing AND no live hands-free loop.
  // The hands-free guard means a double-press on Alt+D while in the loop
  // is a no-op (the loop is already hot) — only MODE_CHANGED can stop it.
  if (isListening() || isProcessing || isHandsFreeActive()) return;

  // Phase J: read persisted mode and dispatch.
  let mode: DiamondMode = 'command';
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const result = await chrome.storage.local.get(['diamond_mode']);
      mode = normalizeMode(result.diamond_mode);
    }
  } catch (e) {
    logger.warn('voice', 'could not read mode, defaulting to command', {
      err: e instanceof Error ? e.message : String(e),
    });
  }
  logger.debug('voice', 'activation routed', { mode, via: lastActivationSource });

  if (mode === 'hands_free') {
    activateHandsFreeMode();
    return;
  }
  // command mode — existing push-to-talk flow follows.
  activateCommandMode();
}

/**
 * Push-to-talk mode (default). One activation = one utterance.
 * Confirmed users continue, unconfirmed commands go to LLM.
 */
async function activateCommandMode(): Promise<void> {
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
    logger.debug('user', 'no transcript (Alt+D released)');
    await speak(ERRORS.STT_NO_SPEECH);
    return;
  }

  logger.info('user', 'voice transcript', {
    text: transcript,
    via: lastActivationSource,
  });

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
      logger.info('confirm', 'pending action cancelled by user');
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
          logger.info('vlm', 'sparse DOM triggered VLM fallback', {
            descriptionLen: vlmResp.description.length,
          });
          await speak('Analyzing page visually...');
        }
      } catch {
        // VLM unavailable — proceed with text-only structure
      }
    }
    console.timeEnd('diamond-vlm');

    // --- Send COMMAND to service worker ---
    console.time('diamond-llm');
    logger.info('command', 'sending COMMAND to SW', {
      transcriptLen: transcript.length,
      pageContextLen: pageContext.length,
      url: window.location.href,
    });
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
      logger.warn('command', 'SW returned empty response');
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
      logger.warn('command', 'SW terminated mid-round-trip', { errMsg });
      await speak(ERRORS.SW_TERMINATED);
    } else {
      console.error('[Diamond] command error:', e);
      logger.error('command', 'round-trip failed', { errMsg });
      await speak(ERRORS.AI_UNAVAILABLE);
    }
  } finally {
    console.timeEnd('diamond-command');
    isProcessing = false;
  }
}

// ---------------------------------------------------------------------------
// Hands-free mode (Phase J)
// ---------------------------------------------------------------------------

/**
 * Continuous listening mode: one activation keeps the mic hot across
 * multiple utterances. Each utterance is processed through the same
 * command pipeline as push-to-talk, then control returns to the listening
 * loop. The loop auto-arms after every `onend` in voice.ts; Diamond
 * sleeps after 60s of no transcript (existing resetSleepTimer hook on
 * STT activity keeps the count fresh).
 *
 * Confirmation flow: a 'confirm' utterance with a pending confirmable
 * runs the action without another LLM round-trip. Otherwise the transcript
 * goes through COMMAND as in command mode.
 *
 * Safety net: stopHandsFree is called when MODE_CHANGED broadcasts back
 * to 'command', so a caretaker can quickly tag a user out of the loop.
 *
 * @returns void — the loop lives in voice.ts, this function is the
 *   callback wiring only.
 */
function activateHandsFreeMode(): void {
  playBeep('awake');
  logger.info('voice', 'hands-free session activating', {
    via: lastActivationSource,
  });

  startHandsFree((transcript) => {
    // Note: this callback runs synchronously relative to recognition,
    // so we await each step before re-arming would normally happen
    // (auto-restart is on onend, not on onresult, so the await here
    // just blocks the next utterance, not the recognizer).
    return processHandsFreeUtterance(transcript).then(() => true);
  });
}

/**
 * Process a single hands-free utterance the same way command mode does:
 * - Handle a pending confirmation directly (no LLM)
 * - Otherwise forward to COMMAND pipeline and speak the response.
 * - Errors are spoken via ERRORS.* constants.
 *
 * @returns Resolves when the utterance's spoken response (or error
 *   fallback) is fully uttered. Auto-restart happens in voice.ts onend.
 */
async function processHandsFreeUtterance(transcriptRaw: string): Promise<void> {
  const transcript = transcriptRaw.trim();
  if (!transcript) {
    logger.debug('user', 'hands-free empty transcript');
    return;
  }

  logger.info('user', 'hands-free voice transcript', {
    text: transcript,
    via: lastActivationSource,
  });

  // ── Pending confirm shortcut ────────────────────────────────────────
  if (hasPendingConfirm()) {
    const confirmResult = checkConfirmation(transcript);
    if (confirmResult.isConfirm && confirmResult.action) {
      try {
        const snap = buildPageSnapshot();
        const result = await executeAction(confirmResult.action, snap);
        if (result) await speak(result);
        logger.info('confirm', 'hands-free confirms pending action');
      } catch (e) {
        logger.error('action', 'hands-free confirm action threw', {
          err: e instanceof Error ? e.message : String(e),
        });
        await speak(ERRORS.SOMETHING_WRONG);
      }
      return;
    }
    if (confirmResult.hadPending) {
      await speak(ERRORS.ACTION_CANCELLED);
      logger.info('confirm', 'hands-free cancels pending action');
      return;
    }
  }

  // ── Standard command path ──────────────────────────────────────────
  const stopProcessing = new logger.Stopwatch('command', 'hands-free utterance');
  try {
    const snap = buildPageSnapshot();
    let pageContext = snap.structure;
    if (isSparseDOM()) {
      try {
        const vlmResp = await chrome.runtime.sendMessage({ type: 'VLM_REQUEST' });
        const description = (vlmResp as { description?: string } | undefined)?.description;
        if (description) {
          pageContext = `Visual: ${description}\n\n${snap.structure}`;
          logger.info('vlm', 'hands-free sparse DOM triggered VLM fallback');
        }
      } catch {
        // VLM unavailable — keep pageContext text-only.
      }
    }
    isProcessing = true;
    const response = await chrome.runtime.sendMessage({
      type: 'COMMAND',
      transcript,
      pageStructure: pageContext,
      url: window.location.href,
    });
    const rawResponse =
      typeof response === 'string'
        ? response
        : (response as { text?: string } | undefined)?.text ?? '';
    if (!rawResponse) {
      logger.warn('command', 'hands-free SW empty response');
      await speak(ERRORS.EMPTY_RESPONSE);
      return;
    }
    await handleResponse(rawResponse, snap);
  } catch (e) {
    const errMsg = String(e);
    if (
      errMsg.includes('message channel closed') ||
      errMsg.includes('receiving end does not exist')
    ) {
      logger.warn('command', 'hands-free SW terminated', { errMsg });
      await speak(ERRORS.SW_TERMINATED);
    } else {
      logger.error('command', 'hands-free round-trip failed', { errMsg });
      await speak(ERRORS.AI_UNAVAILABLE);
    }
  } finally {
    isProcessing = false;
    stopProcessing.stop('done');
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
    logger.info('tts', 'plain speech response', { length: trimmed.length });
    await speak(trimmed);
    return;
  }

  logger.info('action', 'parsed', {
    type: action.action,
    hasElementIndex: 'elementIndex' in action,
    hasFields: 'fields' in action,
    hasPending: 'pendingAction' in action,
  });

  // ── Phase H: Safety net — check for irreversible actions ──────────────
  const elementText = getElementText(action, snapshot);
  const safeAction = wrapIrreversible(action, elementText);

  // Execute via the actions module (Phase F/H)
  try {
    const result = await executeAction(safeAction, snapshot);
    if (result) {
      logger.debug('tts', 'action result spoken', { length: result.length });
      await speak(result);
    }
  } catch (e) {
    logger.error('action', 'executeAction threw', {
      err: e instanceof Error ? e.message : String(e),
    });
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
