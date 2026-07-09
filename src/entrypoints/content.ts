// Diamond Access AI — Content Script
// Phase A: skeleton — log injection, send PAGE_LOAD once
// Phase D: ACTIVATE handler — push-to-talk voice loop
// Phase E: Command integration — full round-trip: listen → DOM walk → LLM → speak → action

import { defineContentScript } from 'wxt/utils/define-content-script';
import {
  playBeep,
  speak,
  startListening,
  isListening,
  resetSleepTimer,
} from '../lib/voice';
import { buildPageSnapshot, isSparseDOM } from '../lib/page-snapshot';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** True while a COMMAND round-trip is in flight — prevents overlapping. */
let isProcessing = false;

/** Elements from the last buildPageSnapshot call (for action resolution). */
let lastElements: HTMLElement[] = [];

/**
 * Pending action awaiting user confirmation (from a "confirm" response).
 * Phase F will wire the full confirmation UX; Phase E stores it and
 * the next COMMAND checks if the transcript is a confirmation.
 */
let pendingAction: Record<string, unknown> | null = null;

// ---------------------------------------------------------------------------
// Action schema types
// ---------------------------------------------------------------------------

interface ActionNone {
  action: 'none';
  speech: string;
}
interface ActionNavigate {
  action: 'navigate';
  url: string;
  description: string;
}
interface ActionClick {
  action: 'click';
  elementIndex: number;
  description: string;
}
interface ActionFillField {
  elementIndex: number;
  value: string;
}
interface ActionFill {
  action: 'fill';
  fields: ActionFillField[];
  description: string;
}
interface ActionConfirm {
  action: 'confirm';
  speech: string;
  pendingAction: Record<string, unknown>;
}

type DiamondAction = ActionNone | ActionNavigate | ActionClick | ActionFill | ActionConfirm;

// ---------------------------------------------------------------------------
// Confirmation phrasing
// ---------------------------------------------------------------------------

/** Phrases the user might say to confirm an action (lowercase). */
const CONFIRM_PHRASES = new Set([
  'yes', 'yeah', 'confirm', 'go ahead', 'do it', 'proceed',
  'sure', 'ok', 'okay', 'yes please', 'please do', 'yep',
]);

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
    lastElements = snap.elements;

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

    // Phase D/E: listen for Alt+D activation from the service worker
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
 * Activate Diamond: awake beep → listen → DOM walk → LLM → speak → action.
 *
 * Guarded by both isListening() (Phase D) and isProcessing (Phase E)
 * to prevent double-activation and overlapping round-trips.
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

  // --- Build page snapshot ---
  isProcessing = true;
  try {
    const snap = buildPageSnapshot();
    lastElements = snap.elements;

    let pageContext = snap.structure;

    // Check if DOM is too sparse — request VLM fallback
    if (isSparseDOM()) {
      try {
        const vlmResponse = await chrome.runtime.sendMessage({
          type: 'VLM_REQUEST',
        });
        const vlmResp = vlmResponse as { description?: string } | undefined;
        if (vlmResp?.description) {
          // Prepend visual description as page context
          pageContext = `Visual context: ${vlmResp.description}\n\nDOM structure:\n${snap.structure}`;
          await speak(`Analyzing page visually...`);
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
    await handleResponse(rawResponse);
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
 * known action schemas, the action is executed. Otherwise, the response is
 * treated as plain speech and spoken aloud.
 *
 * @param rawText - Raw response text from the LLM
 */
async function handleResponse(rawText: string): Promise<void> {
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

  await executeAction(action);
}

/**
 * Execute a parsed DiamondAction.
 */
async function executeAction(action: DiamondAction): Promise<void> {
  switch (action.action) {
    case 'none':
      await speak(action.speech);
      break;

    case 'navigate':
      await speak(action.description);
      window.location.href = action.url;
      break;

    case 'click': {
      const el = resolveElement(action.elementIndex);
      if (!el) {
        await speak("I couldn't find that element on the page.");
        return;
      }
      el.click();
      // If clicking triggers navigation, don't wait for speech
      if (!action.description.startsWith('Going to')) {
        await speak(action.description);
      }
      break;
    }

    case 'fill': {
      for (const field of action.fields) {
        const el = resolveElement(field.elementIndex) as
          | HTMLInputElement
          | HTMLTextAreaElement
          | HTMLSelectElement
          | null;
        if (!el) {
          await speak("I couldn't find a form field on the page.");
          return;
        }
        el.value = field.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await speak(action.description);
      break;
    }

    case 'confirm': {
      pendingAction = action.pendingAction as Record<string, unknown>;
      await speak(action.speech);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Element resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a 1-based elementIndex from the LLM to an actual HTMLElement.
 *
 * @param elementIndex - 1-based index (as returned by LLM)
 * @returns The HTMLElement, or null if out of bounds
 */
function resolveElement(elementIndex: number): HTMLElement | null {
  const idx = elementIndex - 1;
  if (idx < 0 || idx >= lastElements.length) return null;
  return lastElements[idx] ?? null;
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
// Confirm-handler integration (Phase E only — stores pending actions)
// ---------------------------------------------------------------------------

/**
 * Process a transcript that might be a confirmation response.
 * Exported so tests can verify confirmation logic without full activation.
 *
 * @param transcript - The user's spoken transcript
 * @returns True if the transcript was a confirmation and the pending action
 *          was executed; false if no pending action or not a confirmation.
 */
export async function processConfirmation(transcript: string): Promise<boolean> {
  if (!pendingAction) return false;

  const lower = transcript.toLowerCase().trim();
  if (!CONFIRM_PHRASES.has(lower)) {
    // Not a confirmation — clear pending action
    pendingAction = null;
    return false;
  }

  // Execute the pending action
  const action = pendingAction as unknown as DiamondAction;
  pendingAction = null;
  await executeAction(action);
  return true;
}
