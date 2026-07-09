// Diamond Access AI — Service Worker (background)
// Phase A: skeleton — log messages, establish return-true pattern
// Phase C: Fireworks API client — FIREWORKS_TEST handler
// Phase D: chrome.commands.onCommand — Alt+D → ACTIVATE to content script
// Phase E: COMMAND / PAGE_LOAD / VLM_REQUEST handlers, prompt construction
// Phase G: Session + profile, conversation history, goal detection, profile fills

import { defineBackground } from 'wxt/utils/define-background';
import { callLLMWithRetry, callVLM } from '../lib/fireworks';
import {
  PERSONA_BLOCK,
  buildCommandPrompt,
  buildPageLoadPrompt,
  buildVlmPrompt,
} from '../lib/prompts';
import {
  storage,
  detectGoal,
  handleClearCommand,
  handleWhereWasI,
} from '../lib/storage';
import { ERRORS } from '../lib/errors';
import * as logger from '../lib/logger';

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

      // ── GET_LOGS: dump the buffer for the Options Diagnostic panel ─────
      if (msg.type === 'GET_LOGS') {
        sendResponse({ logs: logger.getLogs().map((e) => ({ ...e })) });
        return true;
      }

      // ── CLEAR_LOGS: empty the buffer (button click on Options page) ─────
      if (msg.type === 'CLEAR_LOGS') {
        logger.clearLogs();
        sendResponse({ ok: true });
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
  const sw = new logger.Stopwatch('command', 'COMMAND round-trip');
  try {
    // Check if API key is configured before attempting LLM call
    const { diamond_api_key } = await chrome.storage.local.get('diamond_api_key');
    if (!diamond_api_key) {
      logger.warn('command', 'no API key set', { url: msg.url });
      sendResponse({ text: ERRORS.API_KEY_MISSING });
      return;
    }

    const transcript = msg.transcript as string | undefined;
    const pageStructure = msg.pageStructure as string | undefined;
    const url = msg.url as string | undefined;

    if (!transcript || !pageStructure) {
      logger.warn('command', 'missing transcript or pageStructure', {
        hasTranscript: !!transcript,
        hasPageStructure: !!pageStructure,
      });
      sendResponse({
        text: ERRORS.EMPTY_RESPONSE,
      });
      return;
    }

    logger.info('command', 'received', {
      transcriptLen: transcript.length,
      pageStructureLen: pageStructure.length,
      url,
      transcriptPreview: transcript.slice(0, 80),
    });

    // ── Phase G: Load session ────────────────────────────────────────────
    const session = await storage.getSession();

    // ── Handle "clear context" ───────────────────────────────────────────
    const clearResponse = await handleClearCommand(transcript, storage);
    if (clearResponse) {
      logger.info('command', 'clear context handled');
      sendResponse({ text: clearResponse });
      sw.stop('cleared');
      return;
    }

    // ── Handle "where was I?" ────────────────────────────────────────────
    const whereResponse = handleWhereWasI(transcript, session);
    if (whereResponse) {
      logger.info('command', 'where-was-I handled');
      sendResponse({ text: whereResponse });
      sw.stop('where-was-I');
      return;
    }

    // ── Build context prompt (COMMAND_TASK + page-specific block) ───────
    const userMessage = buildCommandPrompt({
      pageStructure,
      transcript,
      session,
      url,
    });

    logger.debug('llm_request', 'outbound', {
      promptLen: userMessage.length,
      pageStructureLen: pageStructure.length,
      historyTurns: session.conversation.length,
    });

    // ── Call LLM — persona as system role, COMMAND_TASK as user role ─────
    const llmSw = new logger.Stopwatch('llm_response', 'LLM call');
    const responseText = await callLLMWithRetry(PERSONA_BLOCK, userMessage);
    const llmMs = llmSw.stop();

    logger.info('llm_response', 'received', {
      length: responseText.length,
      ms: llmMs,
    });

    // ── Phase G: Update session ─────────────────────────────────────────
    const newGoal = detectGoal(transcript);

    if (newGoal) {
      // Set the new active goal
      session.activeGoal = newGoal;
      logger.info('storage', 'new goal detected', { goal: newGoal });
    }

    // Append the turn to conversation history
    await storage.appendTurn({
      user: transcript,
      assistant: responseText,
    });
    logger.debug('storage', 'turn appended', { conversationLen: session.conversation.length + 1 });

    sendResponse({ text: responseText });
    sw.stop('done');
  } catch (e: unknown) {
    console.error('[background] COMMAND error:', e);
    logger.error('command', 'failure', {
      err: e instanceof Error ? e.message : String(e),
    });
    // Surface the configuration gap explicitly when the LLM client
    // threw because no API key is in chrome.storage.local. Without this
    // match, the user would just hear the generic "AI service unavailable"
    // and not know the fix is to open extension settings.
    const errorMessage = e instanceof Error ? e.message : String(e);
    if (errorMessage.includes('API key not configured')) {
      sendResponse({ text: ERRORS.API_KEY_MISSING });
      sw.stop('api-key-missing');
      return;
    }
    sendResponse({
      text: ERRORS.AI_UNAVAILABLE,
    });
    sw.stop('fallback-error');
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
  const sw = new logger.Stopwatch('page_load', 'PAGE_LOAD');
  try {
    // Check if API key is configured before attempting LLM call
    const { diamond_api_key } = await chrome.storage.local.get('diamond_api_key');
    if (!diamond_api_key) {
      logger.warn('page_load', 'no API key set');
      sendResponse({ summary: ERRORS.API_KEY_MISSING });
      sw.stop('api-key-missing');
      return;
    }

    const url = (msg.url as string) ?? '';
    const structure = (msg.structure as string) ?? '';
    const title = (msg.title as string) ?? '';

    logger.info('page_load', 'received', { url, structureLen: structure.length });

    // ── Build prompt (PAGE_LOAD_TASK + page-specific block) ──────────────
    const prompt = buildPageLoadPrompt({ url, title, structure });

    const llmSw = new logger.Stopwatch('llm_response', 'PAGE_LOAD LLM');
    const summary = await callLLMWithRetry(PERSONA_BLOCK, prompt);
    const llmMs = llmSw.stop();
    logger.info('llm_response', 'PAGE_LOAD summary', { length: summary.length });

    sendResponse({ summary });
    sw.stop('done');
  } catch (e: unknown) {
    console.error('[background] PAGE_LOAD error:', e);
    logger.error('page_load', 'failure', {
      err: e instanceof Error ? e.message : String(e),
    });
    // Graceful fallback — no summary, just page title
    const url = (msg.url as string) ?? '';
    sendResponse({ summary: `Page loaded: ${url}` });
    sw.stop('fallback');
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
  const sw = new logger.Stopwatch('vlm', 'VLM round-trip');
  try {
    logger.info('vlm', 'captureVisibleTab requested');
    const dataUrl = await chrome.tabs.captureVisibleTab({
      format: 'png',
    });

    // Extract base64 from data URL
    const base64 = dataUrl.split(',')[1] ?? '';

    if (!base64) {
      logger.warn('vlm', 'no base64 from dataUrl');
      sendResponse({ description: '' });
      sw.stop('empty-dataurl');
      return;
    }

    logger.debug('vlm', 'image captured', { base64Len: base64.length });

    const llmSw = new logger.Stopwatch('llm_response', 'VLM call');
    const description = await callVLM(PERSONA_BLOCK, base64, buildVlmPrompt());
    const llmMs = llmSw.stop();

    logger.info('llm_response', 'VLM description', {
      length: description.length,
      ms: llmMs,
    });

    sendResponse({ description });
    sw.stop('done');
  } catch (e: unknown) {
    console.error('[background] VLM_REQUEST error:', e);
    logger.error('vlm', 'failure', {
      err: e instanceof Error ? e.message : String(e),
    });
    sendResponse({
      description: ERRORS.AI_UNAVAILABLE,
    });
    sw.stop('fallback');
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
  const sw = new logger.Stopwatch('llm_response', 'FIREWORKS_TEST');
  try {
    const response = await callLLMWithRetry(
      'You are a test echo.',
      'Reply with the word: OK',
    );
    sw.stop('ok');
    logger.info('llm_response', 'FIREWORKS_TEST ok', { reply: response });
    sendResponse({ ok: true, reply: response });
  } catch (e: unknown) {
    logger.error('llm_response', 'FIREWORKS_TEST fail', {
      err: e instanceof Error ? e.message : String(e),
    });
    sw.stop('fail');
    sendResponse({ ok: false, error: String(e) });
  }
}
