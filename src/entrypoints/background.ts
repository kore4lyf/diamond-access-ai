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
  type SupplementarySnapshot,
} from '../lib/prompts';
import { parseCrossTabMatches } from '../lib/cross-tab';
import {
  storage,
  detectGoal,
  detectModeSwitch,
  handleClearCommand,
  handleWhereWasI,
  normalizeMode,
  nextMode,
} from '../lib/storage';
import { ERRORS } from '../lib/errors';
import * as logger from '../lib/logger';

export default defineBackground(() => {
  console.log('Diamond Access AI service worker started');

  // ── DEV-ONLY: auto-enable verbose LLM logging (PC-VLOG companion)
  // Skips the manual `await chrome.storage.local.set(...)` step in SW
  // DevTools the user was previously running by hand. Vite tree-shakes
  // the entire `if (import.meta.env.DEV)` branch out of any production
  // CRX build (`pnpm build`), so shipped extensions never carry this
  // opt-in. Dev installs (`pnpm dev`) get verbose LLM bodies captured
  // automatically — see src/entrypoints/options.html → "Verbose LLM response log".
  if (import.meta.env.DEV) {
    chrome.storage.local.set({ diamond_verbose_llm: true }).catch(() => {});
  }

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
    // Single source of truth for "user pressed a manifest-bound shortcut".
    // PC-A-1 reads the log stream to discriminate Alt+D vs Alt+Shift+D vs
    // Ctrl+Shift+D vs Alt+S — without this entry log they all converge on
    // either tab.sendMessage('ACTIVATE') or toggleModeViaStorage() and the
    // dispatch disappears in the SW. Tag at info so it survives default
    // DebugAndLog level filtering in production.
    logger.info('command', 'manifest command received', { command });

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
      return;
    }

    // Phase J: Alt+S — global activation-mode toggle (Command <-> Hands-Free).
    // Funnels through `toggleModeViaStorage` so the popup-toggle path,
    // voice mode switch, and this Alt+S path all share one copy of the
    // logic. The active tab picks up MODE_CHANGED, speaks the new mode
    // name, and stops any running hands-free loop if going to command.
    if (command === 'toggle-diamond-mode') {
      // chrome.commands.onCommand doesn't carry sender.tab; query active tab
      // so notifyModeChanged targets the visible tab where the user can hear
      // the announcement (PC-A-1: N-tab announcement should be N=1).
      const tabId = await resolveActiveTabId();
      await toggleModeViaStorage(tabId);
      return;
    }
  });

  chrome.runtime.onMessage.addListener(
    (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ) => {
      const msg = message as { type?: string; [key: string]: unknown };
      console.log('[background] received:', msg.type ?? message);

      // ── COMMAND: full user command round-trip ───────────────────────────
      if (msg.type === 'COMMAND') {
        handleCommand(msg, sender, sendResponse);
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

      // ── GET_MODE: popup reads current activation mode ───────────────────
      if (msg.type === 'GET_MODE') {
        storage
          .getMode()
          .then((mode) => {
            sendResponse({ mode });
          })
          .catch((e) => {
            logger.warn('storage', 'GET_MODE failed', {
              err: e instanceof Error ? e.message : String(e),
            });
            sendResponse({ mode: 'command' });
          });
        return true;
      }

      // ── SET_MODE: popup or voice command flips activation mode ──────────
      if (msg.type === 'SET_MODE') {
        const requested = normalizeMode((msg as { mode?: unknown }).mode);
        storage
          .setMode(requested)
          .then(async () => {
            logger.info('storage', 'mode changed', { mode: requested });
            sendResponse({ ok: true, mode: requested });
            // Popup-side SET_MODE has no sender.tab (popup is its own
            // surface). Fall back to active-tab query so the audible
            // announcement lands in the user's visible tab.
            await notifyModeChanged(requested, sender.tab?.id);
          })
          .catch((e) => {
            logger.warn('storage', 'SET_MODE failed', {
              err: e instanceof Error ? e.message : String(e),
            });
            sendResponse({ ok: false, error: String(e) });
          });
        return true;
      }

      // ── OPEN_OPTIONS_CLICKED: just a log + telemetry ping ──────────────
      if (msg.type === 'OPEN_OPTIONS_CLICKED') {
        logger.info('user', 'settings opened via popup');
        sendResponse({ ok: true });
        return true;
      }

      // ── TOGGLE_MODE: Alt+S content-script keydown fallback ──────────────
      // Same effect as the manifest-bound Alt+S — `toggleModeViaStorage`
      // owns the actual flip. Content script uses this path when its
      // capture-phase Alt+S listener fires (chrome:// pages, devtools,
      // or any time the manifest binding is suppressed).
      if (msg.type === 'TOGGLE_MODE') {
        // Content-script Alt+S fallback — sender.tab is the tab the user
        // pressed Alt+S in. Thread it through so notifyModeChanged fires
        // in that exact tab instead of the SW's "best guess" via query.
        toggleModeViaStorage(sender.tab?.id)
          .then(() => sendResponse({ ok: true }))
          .catch((e) => {
            logger.warn('storage', 'TOGGLE_MODE failed', {
              err: e instanceof Error ? e.message : String(e),
            });
            sendResponse({ ok: false });
          });
        return true;
      }

      // Default: acknowledge receipt
      sendResponse({ received: true, type: msg.type ?? 'unknown' });
      return true;
    },
  );

  // No chrome.action.onClicked handler — Phase J added action.default_popup
  // in wxt.config.ts, so Chrome opens popup.html on icon click instead.
  // (Per Chrome docs: when default_popup is set, onClicked does NOT fire.)
  // Caretakers now have a mode toggle + Settings shortcut. The blind user
  // still activates via Alt+D (or Alt+Shift+D / Ctrl+Shift+D), which is
  // unchanged.
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Resolve the tabId to use when no preferredTabId is given to
 * `notifyModeChanged`. Returns undefined when Chrome can't answer
 * (test contexts, manifest errors, etc.). The `number | undefined`
 * shape matches the `sender.tab?.id` chain in callers so the
 * `toggleModeViaStorage` parameter is uniformly optional.
 *
 * Used by:
 *  - `chrome.commands.onCommand` 'toggle-diamond-mode' (Alt+S manifest;
 *    command dispatch doesn't carry sender.tab).
 *  - `onMessage SET_MODE` (from popup — popup is its own surface, no
 *    sender.tab).
 */
async function resolveActiveTabId(): Promise<number | undefined> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id;
  } catch {
    return undefined;
  }
}

/**
 * Single-target MODE_CHANGED dispatch. Only the user's *active* tab
 * audibly announces the mode change ("Hands-free mode." / "Command mode.").
 * Non-active tabs sync state silently via `chrome.storage.onChanged`
 * (see `activateDiamond()` in content.ts) — they don't need a message
 * because storage fires on every listener.
 *
 * Phase J fix for PC-A-1: the earlier `broadcastModeChange` queried every
 * open tab and produced a 1-N repeat of the announcement (N = number of
 * open tabs + 1 each toggle). The fix is single-target semantic.
 *
 * Tabs without a content script (chrome:// pages, the Chrome Web Store,
 * etc.) silently fail — that's expected. Quietly no-op rather than throw.
 */
async function notifyModeChanged(
  mode: ReturnType<typeof normalizeMode>,
  preferredTabId?: number,
): Promise<void> {
  const tabId =
    typeof preferredTabId === 'number' && preferredTabId >= 0
      ? preferredTabId
      : await resolveActiveTabId();
  if (tabId == null) {
    logger.warn('storage', 'no active tab to notify mode change', { mode });
    return;
  }
  logger.info('voice', 'MODE_CHANGED dispatching to tab', { mode, tabId });
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'MODE_CHANGED', mode });
  } catch {
    // chrome:// pages / Web Store don't have a content script — silent.
  }
}

/**
 * Phase J: Toggle the persisted activation mode and notify the active
 * tab. `preferredTabId` is the originating tabId when available
 * (TOGGLE_MODE content-script fallback carries `sender.tab.id`); for
 * Alt+S manifest path the caller passes `await resolveActiveTabId()`.
 *
 * Both entry paths funnel through this helper so the logic lives in one
 * place: `chrome.commands.onCommand` for `toggle-diamond-mode` (Alt+S via
 * the manifest binding), and the content-script Alt+S keydown fallback
 * that forwards as a `TOGGLE_MODE` message. The MODE_CHANGED dispatch
 * triggers two reactions in the active tab:
 *
 *   1. Content script speaks the new mode name (`ERRORS.MODE_*_ON`).
 *   2. If going back to `command` while a hands-free loop is armed,
 *      `stopHandsFree()` is called so the change is immediate.
 *
 * Returns silently on failure — caller can decide whether to surface
 * the error (the SW handler currently doesn't, the message handler logs).
 */
async function toggleModeViaStorage(preferredTabId?: number): Promise<void> {
  try {
    const current = await storage.getMode();
    const flipped = nextMode(current);
    await storage.setMode(flipped);
    logger.info('storage', 'mode toggled', { from: current, to: flipped });
    await notifyModeChanged(flipped, preferredTabId);
  } catch (e) {
    logger.warn('storage', 'toggle mode failed', {
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Cross-tab reference resolver (Phase J + Step F-full)
 *
 * Step F-full adds the ability for a user on tab Z to ask "what's on
 * the BBC tab?" or "compare tab A and tab B". This module:
 *
 *  1. parseCrossTabMatches (src/lib/cross-tab.ts) — pure regex parser;
 *     chromeless, tested in src/lib/__tests__/cross-tab.test.ts.
 *  2. extractCrossTabRefs (this file) — wraps the parser with
 *     chrome.tabs.query to resolve matches to actual tabIds. Dedupes
 *     by tabId, caps at 2 targets for the "no info overload" guard.
 *  3. fetchSupplementarySnapshots (this file) — sends {type:'GET_SNAPSHOT'}
 *     to each resolved tab; per-tab 1.5s timeout; errors swallowed.
 *     Returns SupplementarySnapshot[] (see prompts.ts).
 *
 * Safeguard sequence:
 *  - Default-path-unchanged: parseCrossTabMatches returns [] for
 *    transcripts with no cross-tab reference. Caller gates on that.
 *  - Capped: refs cap at 2 even if more matches exist (so "tell me
 *    about every tab" can't blow the prompt).
 *  - LLM rule: COMMAND_TASK CROSS-TAB RULE paragraph in prompts.ts
 *    instructs the model to use SUPPLEMENTARY TABS ONLY when the
 *    user explicitly asked, otherwise ignore.
 */
interface CrossTabRef {
  /** Displayable substring of the user's transcript that triggered this match. */
  rawText: string;
  /** Resolved Chrome tab id. Null if no matching open tab was found. */
  tabId: number | null;
  /** Displayable tab title for logging only — may be empty if resolution failed. */
  tabTitle: string;
}

/**
 * Detect cross-tab references in the user's transcript and resolve
 * them against currently-open tabs via chrome.tabs.query.
 *
 * Returns 0–2 references, deduplicated by tabId. An empty array means
 * "no cross-tab reference in transcript" — caller should skip the
 * supplementary fetch path entirely.
 */
async function extractCrossTabRefs(
  transcript: string,
): Promise<CrossTabRef[]> {
  try {
    const matches = parseCrossTabMatches(transcript);
    if (matches.length === 0) return [];

    const allTabs = await chrome.tabs.query({});
    const refs: CrossTabRef[] = [];
    const seen = new Set<number>();

    for (const m of matches) {
      if (refs.length >= 2) break;

      if (m.type === 'ordinal') {
        const idx = parseInt(m.match, 10) - 1;
        if (idx >= 0 && idx < allTabs.length) {
          const tab = allTabs[idx];
          if (tab.id != null && !seen.has(tab.id)) {
            seen.add(tab.id);
            refs.push({
              rawText: m.rawText,
              tabId: tab.id,
              tabTitle: tab.title ?? '',
            });
          }
        }
      } else {
        // title-fragment: substring-match against title or URL (lowercased).
        for (const tab of allTabs) {
          if (tab.id == null || seen.has(tab.id)) continue;
          const title = (tab.title ?? '').toLowerCase();
          const url = (tab.url ?? '').toLowerCase();
          if (title.includes(m.match) || url.includes(m.match)) {
            seen.add(tab.id);
            refs.push({
              rawText: m.rawText,
              tabId: tab.id,
              tabTitle: tab.title ?? '',
            });
            break;
          }
        }
      }
    }
    return refs;
  } catch (e) {
    logger.warn('command', 'cross-tab extract failed', {
      err: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

/**
 * Fetch the current page snapshot from each cross-tab ref. Per-tab
 * 1.5s timeout. Errors swallowed (tab closed, no content script, etc.)
 * Cap at 2 results.
 */
async function fetchSupplementarySnapshots(
  refs: CrossTabRef[],
): Promise<SupplementarySnapshot[]> {
  const results: SupplementarySnapshot[] = [];
  for (const ref of refs) {
    if (ref.tabId == null) continue;
    try {
      const response = await Promise.race<unknown>([
        chrome.tabs.sendMessage(ref.tabId, { type: 'GET_SNAPSHOT' }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 1500),
        ),
      ]);
      const data = response as
        | {
            snapshot?: {
              structure?: string;
              title?: string;
              url?: string;
            };
          }
        | undefined;
      if (data?.snapshot?.structure) {
        results.push({
          title: data.snapshot.title || ref.tabTitle,
          url: data.snapshot.url || '',
          // 4000 chars per snapshot is plenty; structure is just a flat
          // list of interactive elements + their accessibility names.
          structure: data.snapshot.structure.slice(0, 4000),
        });
      }
    } catch {
      // tab closed, no content script, or timeout — skip silently
    }
    if (results.length >= 2) break;
  }
  return results;
}

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
  sender: chrome.runtime.MessageSender,
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

    // Phase J: voice mode switch ("switch to hands-free mode / command mode").
    // Targets blind / motor-impaired users who can speak but want to stop
    // pressing Alt+D repeatedly. Same path works for caretakers toggling
    // for the user mid-conversation.
    const modeSwitch = detectModeSwitch(transcript);
    if (modeSwitch) {
      try {
        await storage.setMode(modeSwitch);
        logger.info('storage', 'mode switched via voice command', {
          mode: modeSwitch,
        });
        // Voice fast-path: sender.tab is the tab the user spoke into.
        // Notify that exact tab so the announcement plays once, not N.
        await notifyModeChanged(modeSwitch, sender.tab?.id);
        const reply =
          modeSwitch === 'hands_free'
            ? ERRORS.MODE_HANDS_FREE_ON
            : ERRORS.MODE_COMMAND_ON;
        sendResponse({ text: reply });
        sw.stop('mode-switch-via-voice');
        return;
      } catch (e) {
        logger.warn('storage', 'voice mode-switch failed', {
          err: e instanceof Error ? e.message : String(e),
        });
        sendResponse({ text: ERRORS.MODE_SWITCH_FAILED });
        sw.stop('mode-switch-failed');
        return;
      }
    }

    // ── Handle "where was I?" ────────────────────────────────────────────
    const whereResponse = handleWhereWasI(transcript, session);
    if (whereResponse) {
      logger.info('command', 'where-was-I handled');
      sendResponse({ text: whereResponse });
      sw.stop('where-was-I');
      return;
    }

    // ── Step F-full: cross-tab inquiry (optional) ──────────────────────
    // Detect cross-tab references in the transcript (e.g., "first tab",
    // "the BBC tab", "compare tab A and tab B") and pull the current
    // page snapshot from each named tab to use as supplementary context.
    // Cap of 2 targets. Silent failure if a target tab has no content
    // script or is closed.
    const crossTabRefs = await extractCrossTabRefs(transcript);
    const supplementarySnapshots =
      crossTabRefs.length > 0
        ? await fetchSupplementarySnapshots(crossTabRefs)
        : [];
    if (crossTabRefs.length > 0) {
      logger.info('command', 'cross-tab refs resolved', {
        refCount: crossTabRefs.length,
        fetchedCount: supplementarySnapshots.length,
        refs: crossTabRefs.map((r) => ({
          raw: r.rawText,
          tabId: r.tabId ?? 'no-match',
        })),
      });
    }

    // ── Build context prompt (COMMAND_TASK + page-specific block) ───────
    const userMessage = buildCommandPrompt({
      pageStructure,
      transcript,
      session,
      url,
      supplementarySnapshots,
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
    // PAGE_LOAD_TASK is explicitly prose-only — "two spoken lines, plain
    // English, no lists, no JSON, no 'you can' suggestions." Forcing a
    // JSON-shape retry (the default retries=1) makes the model invent
    // schemas like `{"action":"speak", ...}` on attempt 1 because no
    // schema is in the retry prompt, leaving content.ts to fall through
    // and speak the raw JSON wrapper aloud. PC-QA user verified: that's
    // why "action… speak" was being heard on every page load. retries=0
    // disables that retry path; attempt=0 prose flows back unchanged.
    const summary = await callLLMWithRetry(PERSONA_BLOCK, prompt, 0);
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
