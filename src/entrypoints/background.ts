// Diamond Access AI — Service Worker (background)
// Phase A: skeleton — log messages, establish return-true pattern
// Phase C: Fireworks API client — FIREWORKS_TEST handler
// Phase D: chrome.commands.onCommand — Alt+D → ACTIVATE to content script
// Phase E: COMMAND / PAGE_LOAD / VLM_REQUEST handlers, prompt construction

import { defineBackground } from 'wxt/utils/define-background';
import { callLLMWithRetry, callVLM } from '../lib/fireworks';
import {
  SYSTEM_PROMPT,
  PAGE_LOAD_PROMPT_TEMPLATE,
  VLM_SYSTEM_PROMPT,
} from '../lib/prompts';

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
      const msg = message as { type?: string; [key: string]: unknown };
      console.log('[background] received:', msg.type ?? message);

      // ── COMMAND: full user command round-trip ───────────────────────────
      if (msg.type === 'COMMAND') {
        handleCommand(msg, sendResponse);
        return true; // keep channel open for async response
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
        // Phase C test handler — uses callLLM through callLLMWithRetry
        // (for diagnostics only; COMMAND handler uses the same pipeline)
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
 * COMMAND: Full user command round-trip.
 *
 * Receives { transcript, pageStructure, url } from the content script,
 * builds a single-turn prompt (system prompt + page structure + transcript),
 * calls callLLMWithRetry, and returns the raw response text.
 *
 * @remarks
 * Single-turn only — no conversation history in Phase E.
 * Phase G will add storage.ts + history wrapping.
 */
async function handleCommand(
  msg: Record<string, unknown>,
  sendResponse: (response?: unknown) => void,
): Promise<void> {
  try {
    const transcript = msg.transcript as string | undefined;
    const pageStructure = msg.pageStructure as string | undefined;
    const url = msg.url as string | undefined;

    if (!transcript || !pageStructure) {
      sendResponse({
        text: "I couldn't process that command. Please try again.",
      });
      return;
    }

    // Build a single-turn prompt
    const userMessage = [
      'PAGE STRUCTURE:',
      pageStructure,
      '',
      'URL:',
      url ?? 'unknown',
      '',
      'USER COMMAND:',
      transcript,
    ].join('\n');

    const response = await callLLMWithRetry(SYSTEM_PROMPT, userMessage);
    sendResponse({ text: response });
  } catch (e: unknown) {
    console.error('[background] COMMAND error:', e);
    sendResponse({
      text: 'The AI service is temporarily unavailable. Please try again.',
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
      description: 'Vision analysis is currently unavailable.',
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
