// Diamond Access AI — Service Worker (background)
// Phase A: skeleton — log messages, establish return-true pattern
// Phase C: Fireworks API client — FIREWORKS_TEST handler
// Phase D: chrome.commands.onCommand — Alt+D → ACTIVATE to content script
// Phase E: COMMAND / PAGE_LOAD / VLM_REQUEST handlers, prompt construction
// Phase G: Session + profile, conversation history, goal detection, profile fills

import { defineBackground } from 'wxt/utils/define-background';
import { callLLMWithRetry, callVLM } from '../lib/fireworks';
import {
  SYSTEM_PROMPT,
  PAGE_LOAD_PROMPT_TEMPLATE,
  VLM_SYSTEM_PROMPT,
  buildCommandPrompt,
} from '../lib/prompts';
import {
  storage,
  detectGoal,
  handleClearCommand,
  handleWhereWasI,
} from '../lib/storage';
import { ERRORS } from '../lib/errors';

export default defineBackground(() => {
  console.log('Diamond Access AI service worker started');

  // ───────────────────────────────────────────────────────────────────────
  // API KEY SEEDING — DEV-ONLY (HARD RULE)
  // ───────────────────────────────────────────────────────────────────────
  // Reads VITE_FW_KEY from .env to bridge dev convenience between
  // `pnpm dev` (Termux) and `chrome.storage.local` runtime storage.
  //
  // HARD RULE: This function MUST NEVER run in a production build.
  // Importing `import.meta.env.VITE_FW_KEY` directly would cause Vite
  // to inline the literal key value into the shipped `background.js`,
  // leaking the developer's $50 credit to anyone with the build artifact.
  // The `import.meta.env.DEV` guard ensures Vite tree-shakes the branch
  // out of the production bundle entirely (`pnpm build` strips it).
  //
  // ── Build hygiene checklist (Phase I) ──
  //   1. `pnpm build` runs with VITE_FW_KEY unset in the environment.
  //   2. `grep -RE 'fw_[A-Za-z0-9]{20,}' .output/` returns empty.
  //   3. CI / pre-submit guard fails the build if (2) is non-empty.
  // ───────────────────────────────────────────────────────────────────────
  // Phase I (no-seed): the previous `seedApiKeyIfMissing()` referenced
  // `import.meta.env.VITE_FW_KEY` which Vite inlined into the shipped
  // `background.js`, leaking the developer's Fireworks API key. We have
  // REMOVED that entire path. Users now set their own API key in the
  // extension Options page after install.
  //
  // Note: `import.meta.env.VITE_*` references are now COMPLETELY absent
  // from `src/` — the bundler has nothing to inline. CI guard
  // `scripts/verify-no-secrets.sh` ensures this stays the case.
  chrome.runtime.onInstalled.addListener(async () => {
    console.log('[background] extension installed');
    try {
      await storage.clearSession();
    } catch {
      // Storage not available yet.
    }
  });

  chrome.runtime.onStartup.addListener(async () => {
    console.log('[background] browser startup — clearing session, preserving profile');
    try {
      await storage.clearSession();
    } catch {
      // Storage not available yet.
    }
  });

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
      const msg = message as { type?: string; [key: string]: unknown };
      console.log('[background] received:', msg.type ?? message);

      // ── COMMAND: full user command round-trip ───────────────────────────
      if (msg.type === 'COMMAND') {
        handleCommand(msg, sendResponse);
        return true;
      }

      // ── PAGE_LOAD: auto-summarize on navigation ─────────────────────────
      if (msg.type === 'PAGE_LOAD') {
        handlePageLoad(msg, sendResponse);
        return true;
      }

      // ── VLM_REQUEST: screenshot + vision analysis ────────────────────────
      if (msg.type === 'VLM_REQUEST') {
        handleVlmRequest(sendResponse);
        return true;
      }

      // ── FIREWORKS_TEST: diagnostics — Phase C, kept for options page ────
      if (msg.type === 'FIREWORKS_TEST') {
        handleFireworksTest(msg, sendResponse);
        return true;
      }

      // Default: acknowledge receipt
      sendResponse({ received: true, type: msg.type ?? 'unknown' });
      return true;
    },
  );

  chrome.action.onClicked.addListener((tab) => {
    console.log('[background] toolbar icon clicked for tab', tab.id, tab.url);
  });
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * COMMAND: Full user command round-trip with conversation context.
 *
 * Phase E: Single-turn prompt (system + page structure + transcript).
 * Phase G: Loads session, detects goals, builds context prompt, appends turn.
 *
 * Flow:
 *   1. Load session from storage
 *   2. Check for "clear context" / "where was I?" commands (handled before LLM)
 *   3. Build multi-layer prompt with history + goal
 *   4. Call LLM
 *   5. Detect if a new goal was set and update session
 *   6. Append turn to conversation history
 *   7. Return response
 */
async function handleCommand(
  msg: Record<string, unknown>,
  sendResponse: (response?: unknown) => void,
): Promise<void> {
  try {
    // Check if API key is configured before attempting LLM call
    const { diamond_api_key } = await chrome.storage.local.get('diamond_api_key');
    if (!diamond_api_key) {
      sendResponse({ text: ERRORS.API_KEY_MISSING });
      return;
    }

    const transcript = msg.transcript as string | undefined;
    const pageStructure = msg.pageStructure as string | undefined;
    const url = msg.url as string | undefined;

    if (!transcript || !pageStructure) {
      sendResponse({
        text: ERRORS.EMPTY_RESPONSE,
      });
      return;
    }

    // ── Phase G: Load session ────────────────────────────────────────────
    const session = await storage.getSession();

    // ── Handle "clear context" ───────────────────────────────────────────
    const clearResponse = await handleClearCommand(transcript, storage);
    if (clearResponse) {
      sendResponse({ text: clearResponse });
      return;
    }

    // ── Handle "where was I?" ────────────────────────────────────────────
    const whereResponse = handleWhereWasI(transcript, session);
    if (whereResponse) {
      sendResponse({ text: whereResponse });
      return;
    }

    // ── Build context prompt ────────────────────────────────────────────
    const userMessage = buildCommandPrompt({
      systemPrompt: SYSTEM_PROMPT,
      pageStructure,
      transcript,
      session,
      url,
    });

    // ── Call LLM ─────────────────────────────────────────────────────────
    console.time('diamond-background-llm');
    const responseText = await callLLMWithRetry(SYSTEM_PROMPT, userMessage);
    console.timeEnd('diamond-background-llm');

    // ── Phase G: Update session ─────────────────────────────────────────
    const newGoal = detectGoal(transcript);

    if (newGoal) {
      // Set the new active goal
      session.activeGoal = newGoal;
    }

    // Append the turn to conversation history
    await storage.appendTurn({
      user: transcript,
      assistant: responseText,
    });

    sendResponse({ text: responseText });
  } catch (e: unknown) {
    console.error('[background] COMMAND error:', e);
    // Surface the configuration gap explicitly when the LLM client
    // threw because no API key is in chrome.storage.local. Without this
    // match, the user would just hear the generic "AI service unavailable"
    // and not know the fix is to open extension settings.
    const errorMessage = e instanceof Error ? e.message : String(e);
    if (errorMessage.includes('API key not configured')) {
      sendResponse({ text: ERRORS.API_KEY_MISSING });
      return;
    }
    sendResponse({
      text: ERRORS.AI_UNAVAILABLE,
    });
  }
}

/**
 * PAGE_LOAD: Auto-summary on page navigation.
 *
 * Receives { url, structure } from the content script,
 * builds a "page loaded" prompt, calls callLLMWithRetry,
 * and returns the summary text.
 */
async function handlePageLoad(
  msg: Record<string, unknown>,
  sendResponse: (response?: unknown) => void,
): Promise<void> {
  try {
    // Check if API key is configured before attempting LLM call
    const { diamond_api_key } = await chrome.storage.local.get('diamond_api_key');
    if (!diamond_api_key) {
      sendResponse({ summary: ERRORS.API_KEY_MISSING });
      return;
    }

    const url = (msg.url as string) ?? '';
    const structure = (msg.structure as string) ?? '';

    const prompt = PAGE_LOAD_PROMPT_TEMPLATE.replace('{url}', url).replace(
      '{structure}',
      structure || '(empty page)',
    );

    const summary = await callLLMWithRetry(SYSTEM_PROMPT, prompt);
    sendResponse({ summary });
  } catch (e: unknown) {
    console.error('[background] PAGE_LOAD error:', e);
    // Graceful fallback — no summary, just page title
    const url = (msg.url as string) ?? '';
    sendResponse({ summary: `Page loaded: ${url}` });
  }
}

/**
 * VLM_REQUEST: Vision fallback — capture screenshot and describe it.
 *
 * Called by the content script when the DOM is too sparse (canvas,
 * image-heavy, or minimally-structured pages). Captures the visible
 * tab, sends it to Fireworks as a multimodal message, and returns
 * the visual description.
 */
async function handleVlmRequest(
  sendResponse: (response?: unknown) => void,
): Promise<void> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab({
      format: 'png',
    });

    // Extract base64 from data URL
    const base64 = dataUrl.split(',')[1] ?? '';

    if (!base64) {
      sendResponse({ description: '' });
      return;
    }

    const description = await callVLM(VLM_SYSTEM_PROMPT, base64);
    sendResponse({ description });
  } catch (e: unknown) {
    console.error('[background] VLM_REQUEST error:', e);
    sendResponse({
      description: ERRORS.AI_UNAVAILABLE,
    });
  }
}

/**
 * FIREWORKS_TEST: Diagnostic connection test.
 *
 * Kept from Phase C for the options page "Test connection" button.
 * Uses callLLMWithRetry with a simple test prompt.
 */
async function handleFireworksTest(
  _msg: Record<string, unknown>,
  sendResponse: (response?: unknown) => void,
): Promise<void> {
  try {
    const response = await callLLMWithRetry(
      'You are a test echo.',
      'Reply with the word: OK',
    );
    sendResponse({ ok: true, reply: response });
  } catch (e: unknown) {
    sendResponse({ ok: false, error: String(e) });
  }
}
