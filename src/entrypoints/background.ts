// Diamond Access AI — Service Worker (background)
// Phase A: skeleton — log messages, establish return-true pattern
// Phase C: Fireworks API client — FIREWORKS_TEST handler
// Phase D: chrome.commands.onCommand — Alt+D → ACTIVATE to content script
// Phase E: COMMAND / PAGE_LOAD / VLM_REQUEST handlers, prompt construction
// Phase G: Session + profile, conversation history, goal detection, profile fills

import { defineBackground } from 'wxt/utils/define-background';
import {
  callLLMWithRetry,
  callVLM,
  captureUserSpeech,
  capText,
  MAX_RESPONSE_CHARS,
} from '../lib/fireworks';
import { chunkForRead } from '../lib/content-chunker';
import { cleanChunks } from '../lib/read-aloud-cleanup';
import { summarizeChunks } from '../lib/map-reduce';
import {
  PERSONA_BLOCK,
  buildCommandPrompt,
  buildPageLoadPrompt,
  buildVlmPrompt,
  buildLinkSelectPrompt,
  LINK_SELECT_TASK,
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
import { parseLinkSelectResponse } from '../lib/link-select';
import type { LinkEntry } from '../lib/dom-walk';
import * as logger from '../lib/logger';

export default defineBackground(() => {
  console.log('Diamond Access AI service worker started');

  // ── Defense-in-depth: catch any unhandled promise rejections in the SW
  // so a single dropped message channel doesn't surface as a console
  // "Uncaught" line that confuses PC-QA diagnosis (PC-X-EXTCTX).
  // Real cause of that "Uncaught Error: Extension context invalidated"
  // trace: once Fireworks API fails handlePageLoad → catch calls
  // sendResponse against an already-invalidated channel → sendResponse
  // throws synchronously → async handlePageLoad rejects → unhandled
  // rejection → console warning. With safeSendResponse (below) the
  // primary path no longer throws; this listener is the safety net for
  // any future similar regression.
  self.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
        ? reason
        : String(reason);
    logger.warn('system', 'unhandled rejection (suppressed)', {
      message,
      stack: reason instanceof Error ? reason.stack?.slice(0, 400) : undefined,
    });
    event.preventDefault();
  });

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
  // API KEY SEEDING — DEMO/JUDGE BUILD
  // ───────────────────────────────────────────────────────────────────────
  // Seeds the Fireworks API key from VITE_FW_KEY (inlined by Vite at build
  // time) into chrome.storage.local so judges can use the extension without
  // manually configuring an API key.
  //
  // For hackathon demo builds, the Dockerfile passes VITE_FW_KEY as a build
  // arg, which Vite inlines into the bundle. This allows the extension to
  // work out-of-the-box for judges.
  //
  // Security note: This embeds the API key in the shipped extension. Only
  // use for demo/judge builds, not public releases.
  // ───────────────────────────────────────────────────────────────────────
  async function seedApiKeyIfMissing() {
    const buildTimeKey = import.meta.env.VITE_FW_KEY;
    if (!buildTimeKey) return; // No key baked in — user must configure manually

    try {
      const result = await chrome.storage.local.get('diamond_api_key');
      const existingKey = result.diamond_api_key as string | undefined;
      if (existingKey && existingKey.trim()) return; // User already configured their own key

      await chrome.storage.local.set({ diamond_api_key: buildTimeKey });
      console.log('[background] API key seeded from build-time config');
    } catch (err) {
      console.warn('[background] failed to seed API key:', err);
    }
  }

  chrome.runtime.onInstalled.addListener(async () => {
    console.log('[background] extension installed');
    await seedApiKeyIfMissing();
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
        handleVlmRequest(msg, sender, sendResponse);
        return true;
      }

      // ── DESCRIBE_CROP: bbox-clipped image description ────────────────────
      // Phase J + Image-describe feature. content.ts sends the resolved
      // <img> bounding box (in screenshot pixel space, doubled by DPR)
      // and we capture the active tab, crop, and call the vision LLM.
      // Identical capture/fireworks plumbing to VLM_REQUEST, but bounded
      // to a region so cost stays predictable.
      if (msg.type === 'DESCRIBE_CROP') {
        handleDescribeCrop(msg, sendResponse);
        return true;
      }

      // ── FIREWORKS_TEST: diagnostics — Phase C, kept for options page ────
      if (msg.type === 'FIREWORKS_TEST') {
        handleFireworksTest(msg, sendResponse);
        return true;
      }

      // ── READ_ARTICLE: long-form read-aloud (mode='aloud') or article
      //    map-reduce summary (mode='summarize'). PC-EXT-MAINCONT (HY3
      //    plan): read-aloud bypasses the LLM via chunkForRead +
      //    TTS; summarize uses summarizeChunks (parallel map +
      //    recursive reduce). LLM never narrates the full article —
      //    it stays on the classification side, which is its actual
      //    job.
      if (msg.type === 'READ_ARTICLE') {
        handleReadArticle(msg, sendResponse);
        return true;
      }

      // ── LINK_SELECT: LLM-powered link selection by description.
      // Phase K: When the user asks for a link by semantic description
      // ("open the privacy policy", "the news link about layoffs"),
      // we send all links to the LLM to pick the matching index.
      if (msg.type === 'LINK_SELECT') {
        handleLinkSelect(msg, sendResponse);
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
    // Defense-in-depth transcript capture: voice.ts writes a transcript
    // entry on STT success, and we re-capture here on receipt. Either
    // source suffices; both keep the Options → "Verbose LLM" panel
    // honest about what the user actually said, even when the LLM
    // round-trip never lands (network down, hands-free session closes
    // early, etc.).
    void captureUserSpeech(transcript);

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

    // Defense-in-depth: callLLMWithRetry already caps at MAX_RESPONSE_CHARS
    // on its raw-text fallback path, but the JSON-stringify-success path
    // returns the smaller inner object sized only by the model. Cap here
    // anyway so a model that hallucinates an enormous JSON blob (large
    // speech string, deep elementIndex arrays) can't overflow content.ts.
    const safeResponseText = capText(responseText, MAX_RESPONSE_CHARS);

    logger.info('llm_response', 'received', {
      length: safeResponseText.length,
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

    sendResponse({ text: safeResponseText });
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
      try {
        sendResponse({ text: ERRORS.API_KEY_MISSING });
      } catch (sendErr) {
        logger.warn('command', 'sendResponse threw (channel closed)', {
          err: sendErr instanceof Error ? sendErr.message : String(sendErr),
        });
      }
      sw.stop('api-key-missing');
      return;
    }
    try {
      sendResponse({ text: ERRORS.AI_UNAVAILABLE });
    } catch (sendErr) {
      logger.warn('command', 'sendResponse threw (channel closed)', {
        err: sendErr instanceof Error ? sendErr.message : String(sendErr),
      });
    }
    sw.stop('fallback-error');
  }
}

/**
 * LINK_SELECT: LLM-powered link selection by description.
 *
 * Receives { transcript, links } where links is an array of {index, text, heading, href}.
 * Calls the LLM with a specialized prompt, parses the response, validates that
 * any returned index is real, and maps it to the actual URL.
 */
async function handleLinkSelect(
  msg: Record<string, unknown>,
  sendResponse: (response?: unknown) => void,
): Promise<void> {
  const sw = new logger.Stopwatch('link_select', 'LINK_SELECT');
  try {
    const { diamond_api_key } = await chrome.storage.local.get('diamond_api_key');
    if (!diamond_api_key) {
      sendResponse({ action: 'none', speech: ERRORS.API_KEY_MISSING });
      sw.stop('api-key-missing');
      return;
    }

    const transcript = msg.transcript as string | undefined;
    const linksRaw = msg.links as Array<{ index?: unknown; text?: unknown; heading?: unknown; href?: unknown }> | undefined;

    if (!transcript || !linksRaw?.length) {
      sendResponse({ action: 'none', speech: ERRORS.LINK_NOT_FOUND ?? 'I could not find that link.' });
      sw.stop('missing-input');
      return;
    }

    // Normalize links to the expected shape
    const links = linksRaw
      .map((l, i) => ({
        index: typeof l.index === 'number' ? l.index : i + 1,
        text: typeof l.text === 'string' ? l.text : '',
        heading: typeof l.heading === 'string' ? l.heading : '',
        href: typeof l.href === 'string' ? l.href : '',
      }))
      .filter((l) => typeof l.index === 'number' && l.text && l.href) as unknown as Array<{ index: number; text: string; heading: string; href: string }>;

    // Type-cast to LinkEntry (we know the shape matches after validation)
    const linkEntries = links as LinkEntry[];

    if (linkEntries.length === 0) {
      sendResponse({ action: 'none', speech: ERRORS.LINK_NOT_FOUND ?? 'I could not find that link.' });
      sw.stop('no-valid-links');
      return;
    }

    const userMessage = buildLinkSelectPrompt({ transcript, links: linkEntries });
    const responseText = await callLLMWithRetry(LINK_SELECT_TASK, userMessage);
    const parsed = parseLinkSelectResponse(responseText, linkEntries);

    logger.info('link_select', 'result', { action: parsed.action, transcript });
    sw.stop(parsed.action);
    sendResponse(parsed);
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e);
    logger.error('link_select', 'failure', { err });
    sendResponse({ action: 'none', speech: ERRORS.LINK_SELECT_FAILED ?? 'I could not find that link.' });
    sw.stop('error');
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
    // Graceful fallback — no summary, just page title.
    // sendResponse can throw if the channel has invalidated (extension
    // reloaded mid-round-trip, or sender tab navigated away). Wrap it
    // so the rejection doesn't surface as Uncaught Error in DevTools
    // (PC-X-EXTCTX). Worst case we lose the summary silently; the
    // next page navigation fires a fresh PAGE_LOAD anyway.
    const url = (msg.url as string) ?? '';
    try {
      sendResponse({ summary: `Page loaded: ${url}` });
    } catch (sendErr) {
      logger.warn('page_load', 'sendResponse threw (channel closed)', {
        err: sendErr instanceof Error ? sendErr.message : String(sendErr),
      });
    }
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
  msg: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): Promise<void> {
  const sw = new logger.Stopwatch('vlm', 'VLM round-trip');
  try {
    // Hard cap on the captured screenshot size. A 4K+ screen capture can
    // easily produce 8-15 MB PNGs; posting that to Fireworks wastes
    // vision tokens and risks a 413/400 from the upstream. 8 MB ≈ a
    // legitimate full-page screenshot at 1080p; anything bigger means
    // the user is on a virtual canvas or an unusual screen and we fall
    // back to text-only structure in content.ts.
    const MAX_IMAGE_BASE64_CHARS = 8 * 1024 * 1024;

    logger.info('vlm', 'captureVisibleTab requested');
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });

    // Extract base64 from data URL
    const base64 = dataUrl.split(',')[1] ?? '';

    if (!base64) {
      logger.warn('vlm', 'no base64 from dataUrl');
      sendResponse({ description: '' });
      sw.stop('empty-dataurl');
      return;
    }

    if (base64.length > MAX_IMAGE_BASE64_CHARS) {
      logger.warn('vlm', 'oversized capture, skipping vision fallback', {
        base64Len: base64.length,
        max: MAX_IMAGE_BASE64_CHARS,
      });
      // Empty description — content.ts will fall through to text-only
      // DOM structure if `vlmResp?.description` is falsy. No need to
      // surfacing an unavailable error here; the user's page structure
      // is already prepared.
      sendResponse({ description: '' });
      sw.stop('oversized');
      return;
    }

    logger.debug('vlm', 'image captured', { base64Len: base64.length });

    const llmSw = new logger.Stopwatch('llm_response', 'VLM call');
    const description = await callVLM(PERSONA_BLOCK, base64, buildVlmPrompt());
    const llmMs = llmSw.stop();

    // Cap the description — a runaway vision model can return huge
    // descriptions that would flood the spoken prompt. The content
    // script reads vlmResp.description into the COMMAND prompt and also
    // uses the prefix 'Visual context: ...' on the pageContext assembly.
    const safeDescription = capText(description, MAX_RESPONSE_CHARS);

    logger.info('llm_response', 'VLM description', {
      length: safeDescription.length,
      ms: llmMs,
    });

    sendResponse({ description: safeDescription });
    sw.stop('done');
  } catch (e: unknown) {
    console.error('[background] VLM_REQUEST error:', e);
    logger.error('vlm', 'failure', {
      err: e instanceof Error ? e.message : String(e),
    });
    // Surface a stripped error back to the content script — never leak
    // the full exception string (it can contain Fireworks internal
    // detail). The spoken fallback in ERRORS.AI_UNAVAILABLE is the
    // single user-facing sentence we ship.
    try {
      sendResponse({ description: ERRORS.AI_UNAVAILABLE });
    } catch (sendErr) {
      logger.warn('vlm', 'sendResponse threw (channel closed)', {
        err: sendErr instanceof Error ? sendErr.message : String(sendErr),
      });
    }
    sw.stop('fallback');
  }
}

/**
 * DESCRIBE_CROP: Vision on a cropped region of the visible tab.
 *
 * Phase J + Image-describe feature. content.ts has already resolved
 * an <img> to a bounding box keyed in screenshot pixel space (CSS
 * pixels × devicePixelRatio). We:
 *   1. captureVisibleTab on the active tab → full PNG data URL
 *   2. drawImage onto an OffscreenCanvas at the bbox + 6% padding
 *   3. downscale to ≤1024 max-edge (vision token ceiling)
 *   4. POST the cropped PNG as image_url to callVLM
 *   5. return the spoken description to the content script
 *
 * Distinct from handleVlmRequest (whole-viewport fallback for sparse
 * DOM pages). Both share callVLM, PERSONA_BLOCK, and the same
 * Fireworks endpoint — only the crop path differs.
 */
async function handleDescribeCrop(
  msg: Record<string, unknown>,
  sendResponse: (response?: unknown) => void,
): Promise<void> {
  const sw = new logger.Stopwatch('describe_crop', 'DESCRIBE_CROP round-trip');
  try {
    const bbox = msg.bbox as
      | { x: number; y: number; width: number; height: number }
      | undefined;
    if (!bbox || bbox.width < 1 || bbox.height < 1) {
      logger.warn('describe_crop', 'bad bbox', { bbox });
      sendResponse({ description: '' });
      sw.stop('empty-bbox');
      return;
    }

    logger.info('describe_crop', 'captureVisibleTab requested for crop', { bbox });
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });

    const croppedBase64 = await cropVisibleTabToBbox(dataUrl, bbox);
    if (!croppedBase64) {
      logger.warn('describe_crop', 'crop helper returned null', { bbox });
      sendResponse({ description: '' });
      sw.stop('empty-crop');
      return;
    }

    const llmSw = new logger.Stopwatch('llm_response', 'DESCRIBE_CROP VLM call');
    const description = await callVLM(
      PERSONA_BLOCK,
      croppedBase64,
      'Describe this single image for a blind user. Plain speech. Two sentences max. No lists, no JSON.',
    );
    llmSw.stop();

    logger.info('llm_response', 'DESCRIBE_CROP description', {
      length: description.length,
      pageUrl: msg.pageUrl,
    });
    sendResponse({ description });
    sw.stop('done');
  } catch (e: unknown) {
    console.error('[background] DESCRIBE_CROP error:', e);
    logger.error('describe_crop', 'failure', {
      err: e instanceof Error ? e.message : String(e),
    });
    // Surface a stripped error back to the content script — never leak
    // the full exception string (it can contain Fireworks internal
    // detail). The spoken fallback in ERRORS.AI_UNAVAILABLE is the
    // single user-facing sentence we ship.
    try {
      sendResponse({ description: ERRORS.AI_UNAVAILABLE });
    } catch (sendErr) {
      logger.warn('describe_crop', 'sendResponse threw (channel closed)', {
        err: sendErr instanceof Error ? sendErr.message : String(sendErr),
      });
    }
    sw.stop('fallback');
  }
}

/**
 * Crop a `data:image/png` URL to the given pixel bbox using an
 * OffscreenCanvas. Returns the cropped region as a base64 PNG string
 * (no `data:` prefix), ready for Fireworks image_url input.
 *
 * If the bbox extends beyond the captured bitmap (lazy layout shift,
 * off-frame elements, or the crop math over-estimated), we clamp to
 * the bitmap bounds so drawImage doesn't read garbage. The result is
 * always ≤ 1024 max edge regardless of source resolution to keep
 * vision-token consumption predictable.
 *
 * Pure of chrome.* — takes only a data URL + bbox, returns a string
 * or null on failure. jsdom-friendly path isn't exercised in tests
 * (captureVisibleTab requires real Chrome) but the shape mirrors
 * what `image-capture.ts` would refactor into if more crops land.
 */
async function cropVisibleTabToBbox(
  dataUrl: string,
  bbox: { x: number; y: number; width: number; height: number },
): Promise<string | null> {
  try {
    // dataURL → Blob → ImageBitmap (worker-safe path; no <img> needed)
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    try {
      // Clamp source coords into the bitmap. A bbox ending past the
      // bitmap is a real symptom: captureVisibleTab is bounded to the
      // visible viewport rect, not the full page rect. If the user
      // asked to describe an off-screen image, the crop returns null
      // and the caller speaks a clean error.
      const sx = Math.max(0, Math.min(bitmap.width,  Math.floor(bbox.x)));
      const sy = Math.max(0, Math.min(bitmap.height, Math.floor(bbox.y)));
      const sw = Math.min(bitmap.width  - sx, Math.ceil(bbox.width));
      const sh = Math.min(bitmap.height - sy, Math.ceil(bbox.height));
      if (sw < 1 || sh < 1) return null;

      // Downscale so the longer edge ≤ 1024 px. ~300 vision tokens for
      // a JPEG/PNG at this size; double that for text-on-image content.
      const scale = Math.min(1, 1024 / Math.max(sw, sh));
      const tw = Math.max(1, Math.round(sw * scale));
      const th = Math.max(1, Math.round(sh * scale));

      const canvas = new OffscreenCanvas(tw, th);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, tw, th);

      const outBlob = await canvas.convertToBlob({ type: 'image/png' });
      const bytes = new Uint8Array(await outBlob.arrayBuffer());
      // ArrayBuffer → base64 (safe in SW — no atob/btoa limits hit at
      // single-region sizes ≤ 1024×1024).
      let binary = '';
      // Chunk to avoid stack overflow on large encodings.
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(
          null,
          Array.from(bytes.subarray(i, i + CHUNK)),
        );
      }
      return btoa(binary);
    } finally {
      bitmap.close();
    }
  } catch (e) {
    logger.warn('describe_crop', 'cropVisibleTabToBbox threw', {
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
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
    try {
      sendResponse({ ok: false, error: String(e) });
    } catch (sendErr) {
      logger.warn('llm_response', 'sendResponse threw (channel closed)', {
        err: sendErr instanceof Error ? sendErr.message : String(sendErr),
      });
    }
  }
}

/**
 * READ_ARTICLE: Long-form read-aloud OR condensed map-reduce summary.
 *
 * HY3 plan (PC-EXT-MAINCONT): the LLM was wrongly doing TWO jobs —
 * intent classification AND narrating the full article. The fix
 * separates them:
 *   - mode='aloud': chunkForRead + speak() — LLM is bypassed entirely;
 *     model is invoked LAZILY on chunks that need jargon cleanup.
 *   - mode='summarize': summarizeChunks — parallel map → recursive
 *     reduce. Bounded LLM cost, no chunk dropped.
 *
 * The LLM still gets to do its real job (intent classification via
 * COMMAND_TASK in content.ts) but no longer narrates the full
 * article. That was the original BBC "max chars filled up" bug
 * surfacing in a new shape; this fixes it for good.
 *
 * Graceful-degradation contract (PC-EXT-MAINCONT correction #5):
 * no chunk dropped. Cleanup failure for a chunk falls back to the
 * raw text — better than silent skip. The caller (content.ts
 * streamReadAloud) announces skips inline so the user knows.
 */
async function handleReadArticle(
  msg: Record<string, unknown>,
  sendResponse: (response?: unknown) => void,
): Promise<void> {
  // Hard ceilings — picked so a single misbehaving extraction can't
  // exhaust SW memory or stream dozens of minutes of speech back.
  const MAX_PROSE_CHARS = 200_000;       // 200KB content; chunkForRead handles it
  const MAX_CHUNK_CHARS = 4000;          // Bound any single TTS chunk
  const MAX_CHUNK_COUNT = 80;            // Cap on streamed utterances
  const MAX_SUMMARY_CHARS = 8000;        // Final spoken summary size

  const sw = new logger.Stopwatch('read_article', 'READ_ARTICLE round-trip');
  try {
    const rawMode = msg.mode;
    const mode: 'aloud' | 'summarize' =
      rawMode === 'summarize' ? 'summarize' : (rawMode === 'aloud' ? 'aloud' : 'aloud');
    // Defensive prose cap — a runaway extractMainContent or a user
    // triggering READ_ARTICLE on a 10MB page DOM gets a truncated-but-
    // reasonable prose. Anything past 200KB is unlikely to be useful
    // in TTS anyway. Tell the SW log so PC-QA can see it.
    const rawProse = typeof msg.prose === 'string' ? msg.prose : '';
    const prose = capText(rawProse.trim(), MAX_PROSE_CHARS);

    if (!prose.trim()) {
      logger.warn('read_article', 'no prose', { mode });
      try {
        sendResponse({ error: 'No content to read or summarize.', mode });
      } catch (sendErr) {
        logger.warn('read_article', 'sendResponse threw (channel closed)', {
          err: sendErr instanceof Error ? sendErr.message : String(sendErr),
        });
      }
      sw.stop('no-prose');
      return;
    }

    if (rawProse.length > MAX_PROSE_CHARS) {
      logger.warn('read_article', 'prose truncated to MAX_PROSE_CHARS', {
        raw: rawProse.length,
        capped: prose.length,
      });
    }

    // ── mode='aloud': chunk into TTS-sized utterances; lazy cleanup ──
    if (mode === 'aloud') {
      const chunks = chunkForRead(prose, { locale: typeof msg.lang === 'string' ? msg.lang : undefined });
      // Per-chunk size cap — chunkForRead already targets TTS-friendly
      // sizes, but a chunk that contains a long URL list or unbroken
      // string (image alt attributes, JS payload) can still exceed the
      // cap. Slice with a marker so TTS doesn't emit half a URL.
      const sizeCapped = chunks.map((c) => capText(c, MAX_CHUNK_CHARS));

      logger.info('read_article', 'aloud: chunking done', {
        chunkCount: sizeCapped.length,
      });

      const { diamond_api_key } = await chrome.storage.local.get('diamond_api_key');
      const hasKey = Boolean((diamond_api_key as string | undefined)?.trim());

      const { chunks: cleaned, cleanedFlags, noKeyCount } = await cleanChunks(
        sizeCapped,
        hasKey,
        (c) => callLLMWithRetry(
          'You are a TTS-friendly text normalizer. Output rewritten text only — no commentary, no JSON. Keep the original meaning; expand symbols, replace jargon, decolonize numbers (e.g. 1,000 → one thousand).',
          c,
        ),
      );

      // Cap cleaned output per chunk too — cleanChunks returns text
      // that may have grown during LLM normalization. Bound each one
      // and the total count to MAX_CHUNK_COUNT so a single keystroke
      // can't queue an hour of TTS.
      const finalChunks = cleaned
        .map((c) => capText(c, MAX_CHUNK_CHARS))
        .slice(0, MAX_CHUNK_COUNT);
      const finalFlags = cleanedFlags.slice(0, finalChunks.length);

      logger.info('read_article', 'aloud: ready to stream', {
        chunks: finalChunks.length,
        cleanedCount: finalFlags.filter((f) => !f).length,
        noKeyCount,
      });
      try {
        sendResponse({ chunks: finalChunks, cleanedFlags: finalFlags, noKeyCount, mode: 'aloud' });
      } catch (sendErr) {
        logger.warn('read_article', 'sendResponse threw (channel closed)', {
          err: sendErr instanceof Error ? sendErr.message : String(sendErr),
        });
      }
      sw.stop('aloud');
      return;
    }

    // ── mode='summarize': map-reduce via summarizeChunks ──
    if (mode === 'summarize') {
      logger.info('read_article', 'summarize: planning map-reduce', {
        proseLen: prose.length,
      });
      const { diamond_model } = await chrome.storage.local.get('diamond_model');
      const model = (diamond_model as string | undefined) ?? '';
      try {
        const rawSummary = await summarizeChunks(
          prose,
          model,
          async (systemPrompt, userMessage) => {
            return callLLMWithRetry(systemPrompt, userMessage);
          },
        );
        const summary = capText(rawSummary, MAX_SUMMARY_CHARS);
        sendResponse({ summary, mode: 'summarize' });
      } catch (sendErr) {
        logger.warn('read_article', 'sendResponse threw (channel closed)', {
          err: sendErr instanceof Error ? sendErr.message : String(sendErr),
        });
      }
      sw.stop('summarize');
      return;
    }

    // Unknown mode — surface a clear error rather than silently
    // dropping the request.
    try {
      sendResponse({ error: `Unknown mode: ${String(mode)}`, mode });
    } catch (sendErr) {
      logger.warn('read_article', 'sendResponse threw (channel closed)', {
        err: sendErr instanceof Error ? sendErr.message : String(sendErr),
      });
    }
    sw.stop('bad-mode');
  } catch (e: unknown) {
    console.error('[background] READ_ARTICLE error:', e);
    logger.error('read_article', 'failure', {
      err: e instanceof Error ? e.message : String(e),
    });
    try {
      sendResponse({ error: String(e) });
    } catch (sendErr) {
      logger.warn('read_article', 'sendResponse threw (channel closed)', {
        err: sendErr instanceof Error ? sendErr.message : String(sendErr),
      });
    }
    sw.stop('fail');
  }
}
