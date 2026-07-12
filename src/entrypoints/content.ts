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
  isSpeaking,
  stopSpeaking,
  resetSleepTimer,
  startHandsFree,
  stopHandsFree,
  isHandsFreeActive,
  isHandsFreeRecognitionLive,
} from '../lib/voice';
import { normalizeMode, type DiamondMode } from '../lib/storage';
import { buildPageSnapshot, isSparseDOM } from '../lib/page-snapshot';
import { extractMainContent } from '../lib/main-content';
import { detectLocale } from '../lib/content-chunker';
import {
  executeAction,
  checkConfirmation,
  hasPendingConfirm,
  hasPendingLinkSelect,
  setPendingLinkSelect,
  resolvePendingLinkSelect,
  navigateAction,
  type DiamondAction,
} from '../lib/actions';
import { enumerateLinks, type LinkEntry } from '../lib/dom-walk';
import type { LinkSelectResult } from '../lib/link-select';
import { wrapIrreversible } from '../lib/safety-net';
import { ERRORS } from '../lib/errors';
import { installSPATracker } from '../lib/spa-tracker';
import * as logger from '../lib/logger';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** True while a COMMAND round-trip is in flight — prevents overlapping. */
let isProcessing = false;

/**
 * HY3 plan / PC-STREAM: True while a read-aloud stream is in flight.
 * A second Alt+D mid-read triggers the stop-toggle in activateDiamond
 * (cancels TTS + speaks "Stopped reading."). Separate flag from
 * isProcessing because the streaming path runs without the COMMAND
 * round-trip being live (chunks speak sequentially after the SW resolves).
 */
let isReadingAloud = false;

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
// Console-timer state tracking
// ---------------------------------------------------------------------------
/**
 * console.timeEnd against an unknown label emits a `console.warn`,
 * NOT an exception — so the outer-finally `try { timeEnd } catch {}`
 * added in 087c65e does NOT suppress the `Timer 'diamond-xxx' does
 * not exist` warnings we observed on the success path (where the
 * inline timeEnd inside the COMMAND try block had already ended the
 * label).
 *
 * Track each label in a Set as it starts; only call timeEnd when the
 * label is still in the Set, and remove it on end. This guarantees
 * we never timeEnd an already-ended label — on every path, not just
 * the failure path the 087c65e patch attempted to cover.
 */
const activeTimers = new Set<string>();
function tStart(label: string): void {
  if (activeTimers.has(label)) {
    // Already tracking this timer — don't re-enter console.time
    // (Chrome warns "Timer 'x' already exists").
    return;
  }
  activeTimers.add(label);
  console.time(label);
}
function tEnd(label: string): void {
  if (activeTimers.delete(label)) console.timeEnd(label);
}

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

    // PAGE_LOAD: build snapshot and send to background for auto-summary,
    // but ONLY after the tab is actually visible. On a Chrome session
    // restore, Chrome fires `document_idle` for every tab while they're
    // hidden and then switches focus to the previously-active tab.
    // Without this gate, a 6-tab restore produces 6 back-to-back `speak()`
    // calls for tabs the user is not on — real UX bug reported on PC-V-1.
    // Defer the LLM/page-summary call until the tab is visible; the
    // listener removes itself after firing once so we don't re-summarize
    // on every subsequent hide/show cycle within the same page lifetime.
    const snap = buildPageSnapshot();
    logger.debug('page_load', 'snapshot built', {
      url,
      structureLen: snap.structure.length,
      interactiveCount: snap.elements.length,
    });

    const sendPageLoadSummary = () => {
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
    };

    if (document.visibilityState === 'visible') {
      // Active tab — summarize immediately (existing Phase E behaviour).
      sendPageLoadSummary();
    } else {
      // Tab is hidden — almost certainly Chrome session restore or a
      // backgrounded new tab (middle-click, "open in background"). Wait
      // until the user actually brings the tab forward before speaking.
      logger.info('page_load', 'deferred — tab not visible', {
        visibilityState: document.visibilityState,
        url,
      });
      const onVisible = () => {
        document.removeEventListener('visibilitychange', onVisible);
        logger.info('page_load', 'visibility restored — sending now', { url });
        sendPageLoadSummary();
      };
      document.addEventListener('visibilitychange', onVisible);
    }

    // ----------------------------------------------------------------
    // SPA navigation tracker (Phase K-CRITICAL)
    //
    // Most modern sites are SPAs: Twitter, Gmail, Instagram, GitHub,
    // Reddit, news outlets. They mutate the URL with history.pushState
    // / replaceState / hashchange instead of doing full reloads.
    //
    // PAGE_LOAD only fires on document_idle (one shot). After the user
    // clicks a single in-app link, the URL changes but Diamond's page
    // summary is now stale — they'd hear the FIRST page summary when
    // asking for a fresh one, and every element index would point at
    // the wrong place.
    //
    // Hook the three SPA navigation signals and fire PAGE_LOAD again
    // on each, after an 800ms debounce so we don't spam summaries
    // when sites pushState in tight loops (Twitter's infinite-scroll
    // triggers pushState as the URL updates for new tweets).
    // ----------------------------------------------------------------
    installSPATracker({
      onNavigate: (currentUrl, reason) => {
        if (document.visibilityState !== 'visible') return;
        logger.info('page_load', 'SPA navigation — re-summarizing', {
          reason,
          url: currentUrl,
        });
        const freshSnap = buildPageSnapshot();
        chrome.runtime
          .sendMessage({
            type: 'PAGE_LOAD',
            url: currentUrl,
            structure: freshSnap.structure,
          })
          .then((response) => {
            const resp = response as { summary?: string } | undefined;
            if (resp?.summary) speak(resp.summary);
          })
          .catch(() => undefined);
      },
    });

    // Phase D/E/F: listen for `ACTIVATE` from the service worker
    // (triggered by chrome.commands.onCommand for Ctrl+Shift+D / Alt+Shift+D).
    // Phase F-full: GET_SNAPSHOT (handled below) requires the listener
    // to take the (sender, sendResponse) parameters so we can call
    // sendResponse synchronously. Other message types can still invoke
    // activateDiamond without using sendResponse.
    chrome.runtime.onMessage.addListener(
      (
        message,
        _sender: chrome.runtime.MessageSender,
        sendResponse: (response: unknown) => void,
      ) => {
      const msg = message as { type?: string; mode?: unknown };
      if (msg.type === 'ACTIVATE') {
        lastActivationSource = 'sw';
        activateDiamond();
      }
      // Phase J + Step F-full: cross-tab inquiry. The SW sends
      // { type: 'GET_SNAPSHOT' } when a content script in another tab
      // owns a "named" reference (e.g., "the BBC tab"). We respond with
      // the current page snapshot so the active tab's command pipeline
      // can use it as supplementary context.
      //
      // ─── ACTIVE-TAB ONLY? No — this handler is cross-tab by design. ───
      // It is invoked from background.ts on every tab the user named,
      // NOT just the active tab. The active-tab policy doesn't apply
      // here because we're not speaking; we're only returning a JSON
      // snapshot for the calling tab's LLM context block. The
      // generated `speak()` of the LLM response still happens in the
      // active tab (per Phase J active-tab rule, see activateDiamond's
      // header comment in this file).
      if (msg.type === 'GET_SNAPSHOT') {
        try {
          const snap = buildPageSnapshot();
          sendResponse({
            snapshot: {
              structure: snap.structure,
              title: document.title || '',
              url: window.location.href || '',
            },
          });
        } catch (e) {
          logger.warn('system', 'GET_SNAPSHOT failed', {
            err: e instanceof Error ? e.message : String(e),
          });
          sendResponse({ snapshot: null });
        }
        return true;
      }

      // Phase J: popup-toggle / voice mode switch sends a single-target
      // dispatch (notifyModeChanged in background.ts). Stop a running
      // hands-free loop if this tab has one AND the mode is going to
      // command — that part runs even on hidden tabs because it's just
      // a teardown, no audio.
      if (msg.type === 'MODE_CHANGED') {
        const next = normalizeMode(msg.mode);
        logger.info('voice', 'MODE_CHANGED received', {
          mode: next,
          visible: document.visibilityState,
        });
        if (next === 'command' && isHandsFreeActive()) {
          stopHandsFree();
        }
        // ─── ACTIVE-TAB ONLY ───
        // Defense-in-depth: only the foreground tab audibly speaks the
        // mode-change announcement. SW already targets a single tab via
        // notifyModeChanged, but if a stray MODE_CHANGED ever lands on a
        // background tab (e.g. race condition during tab switch), we
        // don't want to repeat the announcement.
        if (document.visibilityState !== 'visible') {
          logger.info('voice', 'MODE_CHANGED skipped speak in background tab', {
            mode: next,
            reason: 'hidden',
          });
          return;
        }
        // Hands-free: start the listening loop immediately. startHandsFree
        // plays the awake beep as the cue, so we don't also speak the
        // mode name (avoids duplicate audio). This is the start path the
        // activateDiamond docstring already promised but was never wired
        // up — switching to hands-free now begins continuous listening
        // without requiring a separate Alt+D press. Stays after the
        // visibilityState !== 'visible' early-return above so background
        // tabs never spawn a recognizer.
        if (next === 'hands_free') {
          activateHandsFreeMode();
          return;
        }
        // Command-mode transition (incl. coming back from hands-free):
        // speak the change so the user knows Diamond is now push-to-talk
        // (Persona rule — name the action in plain English). The
        // hands-free branch above returns before reaching this line.
        speak(ERRORS.MODE_COMMAND_ON);
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
    //
    // Alt+D is a chord with a real modifier — pressing Alt alone doesn't
    // insert characters into form fields — so we let it fire everywhere
    // (including inputs/textareas/contentEditable). The user explicitly
    // needs Alt+D to work while they're focused in a search box.
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
    //   - preventDefault stops any browser-level handler
    //
    // Alt+S is a chord with a real modifier — same reasoning as Alt+D:
    // we let it fire inside form fields so the user can toggle mode while
    // they're focused in a search box.
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
        e.preventDefault();
        e.stopPropagation();
        chrome.runtime
          .sendMessage({ type: 'TOGGLE_MODE' })
          .catch(() => undefined);
      },
      true, // capture phase
    );

    // ── Double-ESC stop — interrupt Diamond's speech without starting
    // a new listening session. User presses Alt+D to talk next.
    //
    // Same capture-phase pattern as Alt+D: form-field guard, !e.repeat,
    // preventDefault + stopPropagation.
    let lastEscTs = 0;
    window.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        if (e.code !== 'Escape' || e.repeat) return;
        const now = Date.now();
        const target = e.target;
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          (target instanceof HTMLElement && target.isContentEditable)
        ) {
          return; // user is typing — don't interrupt
        }
        // Second ESC within 400ms while Diamond is speaking → stop speech
        if (now - lastEscTs < 400 && (isSpeaking() || isReadingAloud)) {
          isReadingAloud = false;
          stopSpeaking();
          logger.info('action', 'speech_stopped_via_double_esc');
        }
        lastEscTs = now;
      },
      true, // capture phase
    );

    // Phase J: auto-arm hands-free on page load. If the user has hands-free
    // persisted, begin continuous listening immediately — no Alt+D needed.
    // Only the active (visible) tab arms (matches the "main tab is focus"
    // principle and avoids background-tab recognizers). Live toggles are
    // covered by the MODE_CHANGED handler above; this covers fresh loads
    // and navigations into a new page while already in hands-free mode.
    if (
      document.visibilityState === 'visible' &&
      typeof chrome !== 'undefined' &&
      chrome.storage?.local
    ) {
      chrome.storage.local
        .get(['diamond_mode'])
        .then((res) => {
          if (
            normalizeMode(
              (res as { diamond_mode?: unknown }).diamond_mode,
            ) === 'hands_free' &&
            !isHandsFreeActive()
          ) {
            logger.info('voice', 'auto-arming hands-free on page load');
            activateHandsFreeMode();
          }
        })
        .catch(() => undefined);
    }
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
 *
 * ─── ACTIVE-TAB ONLY (Phase J + Step E audit) ───
 * This function runs only in the user's currently-focused tab. Both
 * entry paths — `chrome.runtime.onMessage({type:'ACTIVATE'})` from the
 * content-script Alt+D capture-phase keydown listener, and the
 * MODE_CHANGED-to-'hands_free' transition on this tab — gate on this
 * tab being the active one. Cross-tab sync (Tab X is hands-free, user
 * switches to Tab Y, Tab Y reads `diamond_mode` via storage.onChanged)
 * does NOT re-arm Tab Y's recognizer — that would violate the "main
 * tab is focus" principle and would also accumulate background-tab
 * recognizers (Chrome permission footgun). Y stays in command mode
 * unless the caretaker or the user explicitly says "switch to
 * hands-free" or presses Alt+S while focused on Y. Therefore every
 * `speak()` call below is ACTIVE-TAB ONLY by construction. New
 * contributors adding `speak()` outside this function MUST gate on
 * `document.visibilityState === 'visible'`.
 */
async function activateDiamond(): Promise<void> {
  // ── Interrupt path: Alt+D while Diamond is speaking ──────────────────
  // Either a normal TTS reply (isSpeaking) or a read-aloud stream
  // (isReadingAloud) is in flight. Cancel immediately and start a fresh
  // listening session so the user can give a new command without waiting.
  //
  // screen-reader caveat: cancel() wipes the shared speechSynthesis
  // queue, silencing any concurrent screen-reader speech. This is the
  // unavoidable cost of Chrome not providing a per-utterance cancel API.
  // Consistent with the existing read-aloud stop (previously lines 388-389).
  if (isSpeaking() || isReadingAloud) {
    isReadingAloud = false;
    stopSpeaking();
    logger.info('action', 'speech_interrupted_via_alt_d');
    // Jump straight into a fresh session — no "Stopped reading." blip
    // so the user can talk immediately. Mode routing follows.
    activateDiamondFresh();
    return;
  }

  // Guard: not already listening/processing. A *live* hands-free loop is
  // a no-op (only MODE_CHANGED can stop it). If hands-free is flagged
  // active but no recognizer is actually live (a loop that died silently),
  // Alt+D re-arms it — startHandsFree (Fix 2) clears the orphaned session
  // and starts a fresh loop, so the user can always recover by pressing
  // Alt+D even after a silent death.
  if (isListening() || isProcessing) return;
  if (isHandsFreeRecognitionLive()) return;

  activateDiamondFresh();
}

/**
 * Core activation logic — mode routing + fresh session start.
 * Split out from activateDiamond() so the interrupt path can skip
 * the isSpeaking/isReadingAloud checks and go straight here.
 */
async function activateDiamondFresh(): Promise<void> {
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
  // Set the re-entry guard BEFORE any timer or async work so a
  // second Alt+D press during the command pipeline (including between
  // STT completion and the try block) is blocked by activateDiamond's
  // isProcessing check. Early-return paths must set it back to false.
  isProcessing = true;
  tStart('diamond-command');

  playBeep('awake');
  resetSleepTimer();

  tStart('diamond-stt');
  const transcript = await startListening();
  tEnd('diamond-stt');
  resetSleepTimer();

  if (!transcript) {
    // Per ERRORS.STT_NO_SPEECH: silence on no-speech. The constant is
    // intentionally empty — don't fall back to a spoken message which
    // would defeat the design.
    tEnd('diamond-command');
    isProcessing = false;
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
      tEnd('diamond-command');
      isProcessing = false;
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

  // ── Phase K: pending link-select resolution ───────────────────────────
  if (hasPendingLinkSelect()) {
    const resolved = resolvePendingLinkSelect(transcript);
    if (resolved.resolved && resolved.entry?.href) {
      logger.info('link_select', 'collision resolved', { href: resolved.entry.href });
      isProcessing = false;
      tEnd('diamond-command');
      const navResult = navigateAction(resolved.entry.href);
      if (navResult) await speak(navResult);
      return;
    }
    // Not a resolution — fall through
  }

  // ── Normal command flow ────────────────────────────────────────────────
  isProcessing = true;
  try {
    const snap = buildPageSnapshot();

    tStart('diamond-vlm');
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
    tEnd('diamond-vlm');

    // --- Send COMMAND to service worker ---
    tStart('diamond-llm');
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
    tEnd('diamond-llm');

    const rawResponse =
      typeof response === 'string'
        ? response
        : (response as { text?: string })?.text ?? '';

    if (!rawResponse) {
      // End diamond-command here. This branch returns BEFORE the
      // finally block, so omitting this would leak a "Timer started
      // but never ended" console warning.
      logger.warn('command', 'SW returned empty response');
      tEnd('diamond-command');
      await speak(ERRORS.EMPTY_RESPONSE);
      return;
    }

    // --- Parse and execute response ---
    tStart('diamond-action');
    await handleResponse(rawResponse, snap);
    tEnd('diamond-action');
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
    // End each still-active inner timer via tEnd: it gates on
    // activeTimers membership, so already-ended labels are no-ops
    // and Chrome's "Timer does not exist" warning is never emitted.
    //
    // This block covers the failure paths too — when
    // chrome.runtime.sendMessage or handleResponse throws (e.g.
    // "Extension context invalidated" on SW restart, or "message
    // channel closed"), the inline tEnd calls above never run, so
    // the timer labels are still in activeTimers. tEnd here removes
    // and ends them cleanly. Without this, the next activation would
    // hit `console.time('diamond-llm')` against an already-armed
    // label and emit "Timer 'diamond-llm' already exists" — the
    // original 087c65e symptom, now fixed at the source instead of
    // swallowed by a try/catch (because console.timeEnd on an
    // unknown label is a `console.warn`, not an exception, so the
    // 087c65e try/catch never fired).
    tEnd('diamond-llm');
    tEnd('diamond-action');
    tEnd('diamond-command');
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
 * ─── Active-tab arming rule (Phase J + Step F-light default) ───
 * Only ever called from `activateDiamond()` above, which runs only in
 * the user's currently-focused tab. Cross-tab sync (toggle hands-free
 * in Tab X, switch to Tab Y) does NOT auto-arm Y — Step A's broadcast-
 * fanout fix routes MODE_CHANGED to a single tab, so non-active tabs
 * sync state silently via chrome.storage.onChanged but never invoke
 * `activateDiamond()` themselves. This matches the user's "main tab
 * is focus" principle and avoids background-tab recognizer accumulation.
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

  // ── Phase K: pending link-select resolution ───────────────────────────
  if (hasPendingLinkSelect()) {
    const resolved = resolvePendingLinkSelect(transcript);
    if (resolved.resolved && resolved.entry?.href) {
      logger.info('link_select', 'collision resolved', { href: resolved.entry.href });
      const navResult = navigateAction(resolved.entry.href);
      if (navResult) await speak(navResult);
      return;
    }
    // Not a resolution or cancellation → fall through to normal flow
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

  // HY3 plan / PC-STREAM: read_article / summarize_article own their
  // own pipeline (extractMainContent → SW READ_ARTICLE → speak
  // chunks / speak summary). They bypass executeAction because the
  // handler doesn't fit the click/fill/navigate model — no
  // elementIndex, no safety-net wrap.
  if (action.action === 'read_article' || action.action === 'summarize_article') {
    if (action.action === 'read_article') {
      await readArticleAloud(action.description as string);
    } else {
      await summarizeArticle(action.description as string);
    }
    return;
  }

  // ── Phase K: link selection by description ───────────────────────────
  // The LLM cannot reliably pick an elementIndex for semantic link requests
  // ("open the privacy policy", "the article about layoffs"), so we
  // delegate to a second LLM call with the full link list.
  if (action.action === 'link_select') {
    await handleLinkSelect(action.description as string, snapshot);
    return;
  }

  // ── Phase H: Safety net — check for irreversible actions ──────────────
  // Phase J (PC-QS-1): also pass the resolved DOM element so safety-net
  // can run form-context exemption (search/filter/login submits skip
  // confirm even if the visible text says "Submit").
  const clickEl =
    action.action === 'click'
      ? snapshot.elements[action.elementIndex - 1] ?? null
      : null;
  const elementText = getElementText(action, snapshot, clickEl);
  const safeAction = wrapIrreversible(action, elementText, clickEl);

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

/**
 * Phase K: Handle link selection by description.
 *
 * Called when the LLM returns a `link_select` action. Gathers links from
 * the page, sends them + the description to the service worker for LLM
 * resolution, then navigates or speaks a collision message.
 */
async function handleLinkSelect(
  description: string,
  snapshot: import('../lib/page-snapshot').PageSnapshot,
): Promise<void> {
  const links = enumerateLinks(snapshot);
  if (links.length === 0) {
    await speak('This page has no links.');
    return;
  }

  let resp: unknown;
  try {
    resp = await chrome.runtime.sendMessage({
      type: 'LINK_SELECT',
      transcript: description,
      links,
    });
  } catch {
    await speak(ERRORS.AI_UNAVAILABLE);
    return;
  }

  const result = resp as LinkSelectResult | null;
  if (!result || result.action === 'none') {
    const fallbackSpeech = result?.speech ?? ERRORS.LINK_NOT_FOUND ?? 'I could not find that link.';
    await speak(fallbackSpeech);
    return;
  }

  if (result.action === 'navigate' && result.url) {
    const navResult = navigateAction(result.url);
    if (navResult) await speak(navResult); // error message
    return;
  }

  if (result.action === 'collision' && Array.isArray(result.candidates) && result.candidates.length > 0) {
    const candText = result.candidates
      .map((c, i) => `${i + 1}) ${c.text}`)
      .join('. ');
    const message = result.message ?? 'Several links match.';
    await speak(`${message} ${candText}. Which one?`);
    setPendingLinkSelect(result.candidates);
    return;
  }
}

// ---------------------------------------------------------------------------
// Action validation
// ---------------------------------------------------------------------------

/**
 * Minimal schema check — verifies the parsed object matches one of the
 * known action shapes. Covers all eight schemas from the system prompt.
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

    // ── Phase J + Image-describe feature: vision-action schemas. ─────────
    // describe_image takes an elementIndex pointing at a snapshot-resolved
    // <img>; list_images is parameter-free (the content script enumerates
    // <img> elements directly via dom-walk.enumerateImages() and speaks
    // the list — no LLM call needed for the list phase).
    case 'describe_image':
      return (
        typeof obj.elementIndex === 'number' &&
        typeof obj.description === 'string'
      );

    case 'list_images':
    case 'list_links':
      return typeof obj.description === 'string';

    // HY3 plan / PC-STREAM: read-aloud + summarize-article own their
    // own pipeline (extractMainContent → SW READ_ARTICLE → speak
    // chunks / speak summary). Without this gate, handleResponse
    // falls through to the !action branch and speaks the raw JSON —
    // exactly the "action column read underscore article" trace.
    case 'read_article':
    case 'summarize_article':
      return typeof obj.description === 'string';

    case 'confirm':
      return (
        typeof obj.speech === 'string' &&
        obj.pendingAction !== null &&
        typeof obj.pendingAction === 'object'
      );

    // ── Phase J + Fix 2: browser-chrome actions. All three share the
    //    same shape — a `description` string for the spoken ack.
    //    Without these cases here, the validator falls through to the
    //    `default: return false;` branch and handleResponse speaks the
    //    raw JSON envelope aloud (PC-BACK regression — see 4399dcf).
    case 'back':
    case 'forward':
    case 'refresh':
      return typeof obj.description === 'string';

    // ── Phase K: link selection by description ───────────────────────────
    case 'link_select':
      return typeof obj.description === 'string';

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
  preResolvedEl?: HTMLElement | null,
): string {
  if (action.action === 'click') {
    const el =
      preResolvedEl ?? snapshot.elements[action.elementIndex - 1];
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

// ---------------------------------------------------------------------------
// HY3 plan / PC-STREAM — read-aloud + summarize-article streaming
//
// These own their own pipeline: extractMainContent (local DOM-walk)
// → SW READ_ARTICLE message → speak chunks or speak summary. They
// bypass executeAction because the handler doesn't fit the
// click/fill/navigate model — no elementIndex, no safety-net wrap.
// ---------------------------------------------------------------------------

/**
 * HY3 plan / PC-STREAM: read-aloud pipeline.
 *
 *   1. extractMainContent (readability-scored, dev-gated dry-run
 *      validated) — the REAL page prose, no LLM narration.
 *   2. chrome.runtime.sendMessage READ_ARTICLE mode='aloud' → SW does
 *      chunkForRead + lazy jargon cleanup per chunk (needsModelCleanup).
 *   3. Stream the chunks back through speak() sequentially, checking
 *      isReadingAloud between every chunk so Alt+D mid-stream toggles
 *      stop (cancels TTS, speaks "Stopped reading.").
 *   4. After stream ends, announce how many chunks fell back to raw
 *      text (cleanup failed) — graceful-degradation contract from
 *      PC-EXT-MAINCONT correction #5.
 *
 * Empty prose → speak the apology, no SW round-trip.
 */
async function readArticleAloud(description: string): Promise<void> {
  logger.info('action', 'read_article_aloud: extract starting', { description });

  const result = extractMainContent();
  if (!result.prose.trim()) {
    await speak("Sorry, I couldn't extract any readable content from this page.");
    return;
  }

  let response:
    | { chunks?: string[]; cleanedFlags?: boolean[]; noKeyCount?: number; error?: string }
    | undefined;
  try {
    response = (await chrome.runtime.sendMessage({
      type: 'READ_ARTICLE',
      mode: 'aloud',
      prose: result.prose,
      url: window.location.href,
      lang: detectLocale(document),
    })) as typeof response;
  } catch (e) {
    logger.warn('action', 'READ_ARTICLE sendMessage failed', {
      err: e instanceof Error ? e.message : String(e),
    });
    await speak("Sorry, I couldn't reach the read-aloud service.");
    return;
  }

  if (response?.error || !response?.chunks) {
    await speak(`Sorry — ${response?.error ?? 'no chunks returned'}.`);
    return;
  }

  logger.info('action', 'read_article_aloud: chunking ready', {
    chunkCount: response.chunks.length,
  });

  isReadingAloud = true;
  await speak('Reading this article. Press Alt+D to stop.');

  let stoppedAt = -1;
  for (let i = 0; i < response.chunks.length; i++) {
    if (!isReadingAloud) {
      stoppedAt = i;
      break;
    }
    await speak(response.chunks[i]);
  }
  isReadingAloud = false;

  if (stoppedAt >= 0) {
    logger.info('action', 'read_article_aloud: user-stopped via Alt+D', {
      atChunk: stoppedAt,
      totalChunks: response.chunks.length,
    });
    return;
  }

  // Announce end-of-article (every time). Append cleanup detail only if needed.
  const cleanedCount = response.cleanedFlags?.filter((c) => !c).length ?? 0;
  const noKeyCount = response.noKeyCount ?? 0;
  const rawCount = (response.cleanedFlags?.length ?? 0) - cleanedCount;
  const failedCount = rawCount - noKeyCount;
  const parts: string[] = [];
  if (cleanedCount > 0) parts.push(`${cleanedCount} part${cleanedCount === 1 ? '' : 's'} cleaned`);
  if (noKeyCount > 0) parts.push(`${noKeyCount} part${noKeyCount === 1 ? '' : 's'} kept raw (no API key)`);
  if (failedCount > 0) parts.push(`${failedCount} part${failedCount === 1 ? '' : 's'} kept raw (cleanup failed)`);
  const finishedMsg =
    parts.length > 0
      ? `Finished reading. ${parts.join(', ')}.`
      : 'Finished reading.';
  await speak(finishedMsg);
}

/**
 * HY3 plan / PC-STREAM: summarize-article pipeline.
 *
 * Same extraction as read-aloud, but mode='summarize' routes through
 * SW's map-reduce (parallel summarize + recursive combine). One
 * condensed line is returned and spoken. Empty prose → apology, no
 * SW round-trip.
 */
async function summarizeArticle(description: string): Promise<void> {
  logger.info('action', 'summarize_article: extract starting', { description });

  const result = extractMainContent();
  if (!result.prose.trim()) {
    await speak("Sorry, I couldn't extract any readable content from this page.");
    return;
  }

  let response: { summary?: string; error?: string } | undefined;
  try {
    response = (await chrome.runtime.sendMessage({
      type: 'READ_ARTICLE',
      mode: 'summarize',
      prose: result.prose,
      url: window.location.href,
      lang: detectLocale(document),
    })) as typeof response;
  } catch (e) {
    logger.warn('action', 'READ_ARTICLE sendMessage failed', {
      err: e instanceof Error ? e.message : String(e),
    });
    await speak("Sorry, I couldn't reach the summarize service.");
    return;
  }

  if (response?.error || !response?.summary) {
    await speak(`Sorry — ${response?.error ?? 'no summary returned'}.`);
    return;
  }

  await speak(response.summary);
  logger.info('action', 'summarize_article: spoke summary', {
    length: response.summary.length,
  });
}
