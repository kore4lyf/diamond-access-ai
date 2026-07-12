/**
 * Diamond Access AI — Voice Pipeline
 *
 * Phase D: Gives Diamond ears and a mouth.
 * Runs in the content script (page context) — SpeechRecognition, speechSynthesis,
 * and AudioContext are NOT available in the service worker.
 *
 * Architecture (per DOC-VOICE-STANDARDS §5):
 *   playBeep()         — short audio cue via singleton AudioContext
 *   speak()            — TTS via SpeechSynthesisUtterance (always local)
 *   startListening()   — STT via SpeechRecognition (cloud by default, on-device opt-in)
 *   isListening()      — boolean guard against double-activation
 *   resetSleepTimer()  — 60s inactivity timeout → sleep beep + flag off
 *
 * This module exports voice primitives ONLY. No Fireworks, no DOM walk.
 * Phase E stitches everything together.
 *
 * Guardrails (hard rules):
 *   - No Fireworks import
 *   - No wake-word detection (stretch goal, parked)
 *   - No getUserMedia — browser handles mic prompt on recognition.start()
 *   - No new permissions (still ["activeTab","storage"])
 *   - Singleton AudioContext — do not create one per beep
 *   - isListening() guard prevents double-activation
 *   - Sleep timeout 60s — any voice activity resets it
 *   - speechSynthesis.cancel() is ONLY used by stopSpeaking() for
 *     user-initiated interrupts (Alt+D while speaking, double-ESC).
 *     Annotated as intentional: cancels the shared TTS queue including
 *     screen-reader speech — accepted trade-off for immediate stop.
 */

import { ERRORS } from './errors';
import * as logger from './logger';
import { captureUserSpeech } from './fireworks';
import { stripSpokenMarkdown } from './text-format';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BeepType = 'awake' | 'sleep';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Singleton AudioContext for beep generation. */
let audioContext: AudioContext | null = null;

/** True while SpeechRecognition is active. Guards double-activation. */
let listeningFlag = false;

/** Current sleep timer handle (or null if no timer active). */
let sleepTimerId: ReturnType<typeof setTimeout> | null = null;

/** The active SpeechRecognition instance (for potential abort). */
let activeRecognition: SpeechRecognition | null = null;

/** True while a hands-free session is active (continuous listening loop). */
let handsFreeActive = false;

/**
 * Stopwatch tracking the full hands-free session lifecycle (startHandsFree
 * entry → exit by stopHandsFree / mic-blocked / max-restarts / reject
 * callback). PC-HF-1 / PC-HF-2 read this to confirm "one Alt+D arms the
 * loop, multiple utterances flow without re-press, 60 s of silence
 * cleanly wraps." Reset on stop so a new session starts a fresh timer.
 */
let handsFreeStopwatch: logger.Stopwatch | null = null;

/** Restart counter — guards against tight error-restart loops. */
let handsFreeRestartCount = 0;

/** True while speechSynthesis is speaking. Used by interrupt logic. */
let speakingFlag = false;
const HANDS_FREE_MAX_RESTARTS_WITHOUT_RESULT = 8;

/**
 * Centralized teardown for the hands-free session. Used at every spot
 * where we'd otherwise write `handsFreeActive = false;` directly so the
 * session-duration stopwatch cleans up symmetrically — no orphan timers
 * if we crash out of armOnce or hit a non-recoverable recognizer error.
 *
 * @param reason - Short tag for the stopwatch stop log ("user-stopped",
 *   "mic-blocked", "max-restarts", "callback-rejected", "start-threw",
 *   etc). Goes into logcat as the stop reason.
 */
function clearHandsFreeSession(reason: string): void {
  if (handsFreeStopwatch) {
    handsFreeStopwatch.stop(reason);
    handsFreeStopwatch = null;
  }
  handsFreeActive = false;
}

// ---------------------------------------------------------------------------
// Audio cues (beeps)
// ---------------------------------------------------------------------------

/** Play a short audio cue — awake (880Hz) or sleep (440Hz), ~150ms blip. */
export function playBeep(type: BeepType): void {
  try {
    if (typeof AudioContext === 'undefined') {
      console.log('[Diamond] AudioContext not available — skipping beep');
      return;
    }

    if (!audioContext) {
      audioContext = new AudioContext();
    }

    // Resume if suspended (browser autoplay policy)
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }

    const frequency = type === 'awake' ? 880 : 440;
    const duration = 0.15; // 150ms

    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime);

    // Quick attack, then release
    gain.gain.setValueAtTime(0.3, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.01,
      audioContext.currentTime + duration,
    );

    oscillator.connect(gain);
    gain.connect(audioContext.destination);

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + duration);
  } catch (e) {
    console.log('[Diamond] beep failed:', e);
  }
}

// ---------------------------------------------------------------------------
// Text-to-speech
// ---------------------------------------------------------------------------

/**
 * Speak text via SpeechSynthesisUtterance.
 * Resolves on the final utterance's `onend` or `onerror` — never blocks on
 * TTS failure.
 *
 * Hardening (this revision):
 *   - null / undefined / empty input → resolves immediately, no TTS call.
 *   - Sanitization pipeline before TTS, in order:
 *       stripHtmlTags → sanitizeTextForTTS (zero-width + control chars) →
 *       stripMarkdownLinks → stripSpokenMarkdown (existing).
 *     The existing stripSpokenMarkdown handles **bold**, _italic_, code
 *     fences, escape sequences, and JSON brackets; voice.ts adds HTML tag
 *     and markdown link stripping because LLM drift has been seen leaking
 *     `<b>...</b>` and `[text](url)` patterns that TTS reads literally.
 *   - Very long text is chunked on sentence / word / hard-cut boundaries
 *     and the chunks are queued sequentially so the TTS engine doesn't
 *     silently truncate an oversized response. Single-chunk input still
 *     produces a single utterance — onend resolves the outer promise.
 *
 * Voice selection priority (unchanged):
 *   1. localService === true && lang === 'en-US'
 *   2. lang === 'en-US'
 *   3. voices[0] (fallback)
 *
 * NOTE: speechSynthesis.cancel() is intentionally used by stopSpeaking()
 * for user-initiated interrupts (Alt+D / double-ESC while speaking).
 * See stopSpeaking() JSDoc for the screen-reader caveat.
 */
export function speak(text: string | null | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (
      typeof speechSynthesis === 'undefined' ||
      typeof SpeechSynthesisUtterance === 'undefined'
    ) {
      console.log('[Diamond] speechSynthesis not available');
      resolve();
      return;
    }

    // No-op for null / undefined / non-string / empty / whitespace input.
    // A blind user hearing an empty or error-spoken utterance is worse than
    // a silent resolution — keeping the contract here means callers can
    // safely pipe any LLM output through speak() without empty-result
    // surprise. Existing callers passing '' are unaffected (this branch
    // wasn't previously reachable).
    if (
      typeof text !== 'string' ||
      text.trim() === ''
    ) {
      resolve();
      return;
    }

    // Defense-in-depth (Round 1B + Hardening). Strip markdown / JSON /
    // escape noise from any text going to TTS. The LLM is told to produce
    // plain prose, but model drift can leak `**`, `_`, `\\`, brackets,
    // HTML tags, and links. TTS reads those as words ("asterisk",
    // "underscore", "backslash backslash", "less than b greater than",
    // "open bracket here close bracket") — disaster for spoken output.
    // Single choke point covers every speak() caller.
    const beforeChars = text.length;
    let cleanText = stripHtmlTags(text);
    cleanText = sanitizeTextForTTS(cleanText);
    cleanText = stripMarkdownLinks(cleanText);
    cleanText = stripSpokenMarkdown(cleanText);

    // Sanitization collapsed the input to nothing — fall through as no-op.
    if (cleanText.trim() === '') {
      resolve();
      return;
    }

    if (cleanText.length !== beforeChars) {
      logger.debug('tts', 'spoken text cleaned', {
        beforeChars,
        afterChars: cleanText.length,
      });
    }

    // Select best available voice once — reused for every chunk.
    const voices = speechSynthesis.getVoices();
    const preferred =
      voices.find((v) => v.lang === 'en-US' && v.localService) ??
      voices.find((v) => v.lang === 'en-US') ??
      voices[0] ??
      null;

    // Chunk very long text so the TTS engine doesn't silently truncate
    // an oversized response. Single-chunk input preserves original
    // single-utterance behavior to keep existing tests green.
    const chunks = chunkTextForTTS(cleanText);
    if (chunks.length > 1) {
      logger.debug('tts', 'text chunked for sequential TTS', {
        chunkCount: chunks.length,
        totalChars: cleanText.length,
      });
    }

    const speakNext = (index: number): void => {
      // Chain finished — clear flag and resolve once.
      if (index >= chunks.length) {
        speakingFlag = false;
        resolve();
        return;
      }

      const utterance = new SpeechSynthesisUtterance(chunks[index]);
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;

      if (preferred) {
        // Chrome loads voices asynchronously; if none yet, speak() still
        // works with the system default voice. Do NOT set utterance.voice
        // after speaking as that can re-trigger Chrome's queue on some
        // pages (BBC re-read bug). Setting once here per chunk is safe.
        utterance.voice = preferred;
      }

      // Advance the chain on either success or error — never block. The
      // outer promise resolves once we've drained every chunk. onerror on
      // a non-final chunk continues the chain (matches single-utterance
      // "don't block on TTS errors" intent).
      utterance.onend = () => { speakNext(index + 1); };
      utterance.onerror = () => { speakNext(index + 1); };

      speakingFlag = true;
      speechSynthesis.speak(utterance);
    };

    speakNext(0);
  });
}

// ---------------------------------------------------------------------------
// Speech-to-text
// ---------------------------------------------------------------------------

/**
 * Start listening via Web Speech API SpeechRecognition.
 *
 * Resolves with the transcript on successful recognition.
 * On error: speaks an appropriate message, resolves with ''.
 *
 * Mode:
 *   - Cloud (default): audio sent to Google's Cloud Speech-to-Text
 *   - On-device (Chrome 139+): processLocally=true if available/en-US/command
 *
 * @returns Promise resolving with the recognized transcript (or '' on error)
 */
export function startListening(): Promise<string> {
  // Install the visibility hook lazily so a background tab doesn't
  // keep the mic armed. Idempotent — the listener installs at most
  // once per module instance.
  ensureVisibilityHook();

  // Guard: no-op if already listening (prevents double-activation)
  if (listeningFlag) {
    return Promise.resolve('');
  }

  return new Promise((resolve) => {
    // Feature-detect SpeechRecognition (standard prefix or webkit prefix)
    const hasWindow = typeof window !== 'undefined';
    const win = hasWindow
      ? (window as unknown as Record<string, unknown>)
      : null;
    const SpeechRecognitionCtor: SpeechRecognitionStatic | undefined =
      (win?.SpeechRecognition as SpeechRecognitionStatic | undefined) ??
      (win?.webkitSpeechRecognition as SpeechRecognitionStatic | undefined);

    if (!SpeechRecognitionCtor) {
      console.log('[Diamond] SpeechRecognition not available');
      resolve('');
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    // Defensive null guard — a ctor returning null/undefined used to
    // crash the next listener wiring (TypeError on `recognition.onstart =
    // ...`). Resolve silently instead. Chrome never does this, but a
    // hostile / mocked environment could.
    if (!recognition) {
      console.log('[Diamond] SpeechRecognition constructor returned null');
      resolve('');
      return;
    }
    activeRecognition = recognition;
    listeningFlag = true;

    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    // Chrome 139+ on-device detection
    if (typeof recognition.processLocally !== 'undefined') {
      recognition.processLocally = false; // default: cloud

      if (typeof SpeechRecognitionCtor.available === 'function') {
        SpeechRecognitionCtor
          .available({
            langs: ['en-US'],
            processLocally: true,
            quality: 'command',
          })
          .then((available) => {
            if (available === 'available') {
              recognition.processLocally = true;
              logger.debug('stt', 'on-device STT available');
            }
          })
          .catch(() => {
            // Silently fall back to cloud
            logger.debug('stt', 'on-device probe failed, cloud fallback');
          });
      }
    }

    const sttSw = new logger.Stopwatch('stt', 'STT recognition');

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = event.results[0][0].transcript ?? '';
      const ms = sttSw.stop();
      logger.info('stt', 'transcript recognized', {
        text: transcript,
        ms,
      });
      // Belt-and-suspenders capture: voice.ts writes here, AND the SW
      // also writes in handleCommand. Either source suffices; both
      // keep the Options → "Verbose LLM response log" panel honest
      // about what the user actually said.
      void captureUserSpeech(transcript);
      cleanup(true);
      resetSleepTimer();
      resolve(transcript);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      const error = event.error;
      sttSw.stop('error');
      logger.warn('stt', 'recognition error', { error });

      if (error === 'network') {
        speak(ERRORS.STT_NETWORK);
      } else if (
        error === 'not-allowed' ||
        error === 'service-not-allowed'
      ) {
        speak(ERRORS.MIC_BLOCKED);
      } else if (error === 'no-speech' || error === 'aborted') {
        // Silent — resolve with empty transcript. 'aborted' is expected
        // when the caller (or the visibility hook) calls stop() while
        // results were still pending; treat it the same as no-speech so
        // Alt+D / push-to-talk doesn't trigger a noisy error message.
        cleanup(false);
        resolve('');
        return;
      } else {
        speak(ERRORS.STT_OTHER);
      }

      cleanup(false);
      resolve('');
    };

    recognition.onspeechend = () => {
      logger.debug('stt', 'speech ended, stopping recognition');
      recognition.stop();
    };

    try {
      recognition.start();
      logger.info('stt', 'recognition started', {
        lang: recognition.lang,
        processLocally: recognition.processLocally,
      });
    } catch (e) {
      // start() can throw InvalidStateError when called twice in rapid
      // succession (the very common Alt+D / Alt+D case) — and the
      // guarding isListeningFlag check above doesn't always catch it
      // because the false-return path leaves the recognizer half-armed.
      // Resolve empty rather than throwing to the caller.
      logger.warn('stt', 'recognition.start() threw', {
        err: e instanceof Error ? e.message : String(e),
      });
      listeningFlag = false;
      activeRecognition = null;
      resolve('');
    }
  });
}

// ---------------------------------------------------------------------------
// Hands-free mode (Phase J)
//
// Continuous listening: one activation keeps the mic hot across multiple
// utterances. Recognition auto-restarts after `onend` until the user
// releases (stopHandsFree) or 60s passes with no transcript (sleep beep).
//
// Auto-restart is the standard pattern for continuous STT in Chrome —
// SpeechRecognition.end() fires after every final result (or error), so
// we start() again immediately. We do NOT spin a tight loop on errors
// (HANDS_FREE_MAX_RESTARTS_WITHOUT_RESULT catches mic-blocked loops).
// ---------------------------------------------------------------------------

/**
 * Start hands-free listening — one activation, multiple utterances.
 *
 * Behavior:
 *   - Plays awake beep.
 *   - Starts SpeechRecognition with continuous=true.
 *   - On `onresult`: invokes the transcript callback and auto-restarts.
 *   - On `onend`: auto-restarts until stopHandsFree() or exhaustion.
 *   - Sleep after 60s no transcript (existing resetSleepTimer).
 *
 * Calling contract — Phase J + Step F-light:
 *   Called only from `activateHandsFreeMode()` in content.ts, which is
 *   itself only reached from `activateDiamond()` in the user's active
 *   tab. There is no other entry path; the SW never calls this directly.
 *   Background tabs hold the mode in storage but do NOT start a
 *   recognizer — see the `activateHandsFreeMode` docstring in
 *   content.ts for the "main tab is focus" rationale.
 *
 * @param onUtterance - Called with each recognized transcript. May return
 *   synchronously (boolean | void) or as a Promise that resolves to the
 *   same. Returning `false` (sync or async) stops the hands-free loop.
 *   Sync throws are caught and logged so a buggy callback can't kill the
 *   loop.
 */
export function startHandsFree(
  onUtterance: (
    transcript: string,
  ) => boolean | void | Promise<boolean | void>,
): void {
  // Guard: don't double-arm a genuinely live hands-free loop. A loop
  // that died silently leaves `handsFreeActive` true but
  // `activeRecognition` null — clear that orphaned session and re-arm so
  // MODE_CHANGED and Alt+D can reliably (re)start listening even after a
  // silent death.
  if (handsFreeActive && activeRecognition) {
    logger.warn('voice', 'startHandsFree called while already active');
    return;
  }
  if (handsFreeActive && !activeRecognition) {
    logger.info('voice', 'startHandsFree recovering orphaned session');
    clearHandsFreeSession('recover-orphan');
  }

  const win =
    typeof window !== 'undefined'
      ? (window as unknown as Record<string, unknown>)
      : null;
  const SpeechRecognitionCtor: SpeechRecognitionStatic | undefined =
    (win?.SpeechRecognition as SpeechRecognitionStatic | undefined) ??
    (win?.webkitSpeechRecognition as SpeechRecognitionStatic | undefined);

  if (!SpeechRecognitionCtor) {
    logger.warn('voice', 'SpeechRecognition not available for hands-free');
    // Best existing fallback — STT_OTHER is terse and doesn't lie about
    // the underlying issue (we'd need a separate VOICE_UNSUPPORTED constant
    // to be more precise, which is post-MVP polish).
    speak(ERRORS.STT_OTHER);
    return;
  }

  handsFreeActive = true;
  handsFreeRestartCount = 0;
  // True while an utterance is being processed (STT result → LLM → TTS).
  // While set we must NOT re-arm a new recognizer, otherwise a single
  // command loops; and the recognizer's own `onend` (fired by our
  // stop() below) must not double-start a second recognizer.
  let handsFreeProcessing = false;
  // Start a fresh session stopwatch. PC-HF-1 verifies the timer runs from
  // here through the entire loop; PC-HF-2 verifies the stop reason path.
  // If a previous stopwatch is somehow still alive (recovery from a
  // crash-out that didn't reach clearHandsFreeSession), close it out
  // first so we never leak an orphan timer.
  if (handsFreeStopwatch) {
    handsFreeStopwatch.stop('recovery-on-resume');
    handsFreeStopwatch = null;
  }
  handsFreeStopwatch = new logger.Stopwatch('voice', 'hands-free session');

  playBeep('awake');
  logger.info('voice', 'hands-free started');

  const armOnce = (): void => {
    if (!handsFreeActive || handsFreeProcessing) return;

    let recognition: SpeechRecognition;
    try {
      recognition = new SpeechRecognitionCtor();
    } catch (e) {
      logger.error('voice', 'failed to construct recognition in hands-free', {
        err: e instanceof Error ? e.message : String(e),
      });
      clearHandsFreeSession('construct-failed');
      return;
    }

    activeRecognition = recognition;
    listeningFlag = true;

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    if (typeof recognition.processLocally !== 'undefined') {
      recognition.processLocally = false;
    }

    // Index of the last final result already handed to the utterance
    // callback. continuous + interimResults means `event.results` keeps
    // every prior result, so without this guard each later `onresult`
    // (driven by ongoing mic input) re-fires the same final — the
    // "command repeats itself" bug.
    let lastFinalIndex = -1;

    recognition.onstart = () => {
      logger.debug('stt', 'hands-free session start');
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      if (handsFreeProcessing) return; // already handling a final
      handsFreeRestartCount = 0;
      resetSleepTimer();

      // Only act on a NEW final result past what we've processed.
      let finalIndex = -1;
      let finalTranscript = '';
      for (let i = event.results.length - 1; i > lastFinalIndex; i--) {
        const result = event.results[i];
        if (result && result.isFinal) {
          finalIndex = i;
          finalTranscript = result[0]?.transcript ?? '';
          break;
        }
      }
      if (finalIndex === -1) return; // interim only or already processed
      lastFinalIndex = finalIndex;

      logger.info('stt', 'hands-free transcript', {
        text: finalTranscript,
      });

      // Stop the recognizer now: (1) the final persists in event.results,
      // so leaving it open re-fires it on the next `onresult`; (2)
      // Diamond's spoken reply must not be captured by the still-open mic.
      // Processing owns the re-arm below.
      handsFreeProcessing = true;
      try {
        recognition.stop();
      } catch {
        // already stopping
      }

      Promise.resolve()
        .then(() => onUtterance(finalTranscript))
        .then((keepGoing) => {
          handsFreeProcessing = false;
          if (keepGoing === false) {
            logger.info('voice', 'utterance callback requested stop');
            handsFreeActive = false;
            try {
              recognition.stop();
            } catch {
              // already stopped
            }
            return;
          }
          // Re-arm only after the utterance is fully handled.
          if (handsFreeActive) armOnce();
        })
        .catch((err) => {
          handsFreeProcessing = false;
          logger.error('voice', 'utterance callback threw', {
            err: err instanceof Error ? err.message : String(err),
            transcript: finalTranscript,
          });
          // Sync throw from a buggy callback never breaks the loop.
          if (handsFreeActive) armOnce();
        });
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      handsFreeRestartCount++;
      const error = event.error;
      logger.warn('stt', 'hands-free error', {
        error,
        restartCount: handsFreeRestartCount,
      });

      if (error === 'no-speech' || error === 'aborted') {
        // Expected — 'aborted' fires when stop() is called (e.g. final
        // result processing in our onresult handler), 'no-speech' fires
        // when the user simply didn't speak. onend's auto-restart covers
        // both — fall through silently rather than counting them or
        // surfacing STT errors to the user.
        return;
      }
      if (error === 'not-allowed' || error === 'service-not-allowed') {
        speak(ERRORS.MIC_BLOCKED);
        clearHandsFreeSession('mic-blocked');
        return;
      }
      if (error === 'network') {
        speak(ERRORS.STT_NETWORK);
        clearHandsFreeSession('network');
        return;
      }
      // Unknown / abort — auto-restart will pick it up if arms remain.
      if (handsFreeRestartCount > HANDS_FREE_MAX_RESTARTS_WITHOUT_RESULT) {
        logger.warn(
          'voice',
          'hands-free aborting after too many restarts without result',
        );
        speak(ERRORS.STT_OTHER);
        clearHandsFreeSession('max-restarts');
      }
    };

    recognition.onend = () => {
      listeningFlag = false;
      // Stale `onend` from a recognizer we already replaced/stopped while
      // processing — ignore it so we don't tear down the live recognizer.
      if (recognition !== activeRecognition) return;
      activeRecognition = null;
      logger.debug('stt', 'hands-free session end', {
        handsFreeActive,
        handsFreeProcessing,
      });
      if (!handsFreeActive) {
        logger.info('voice', 'hands-free stopped cleanly');
        return;
      }
      // While an utterance is being processed we stopped the recognizer
      // ourselves; its `onend` must NOT also re-arm or we'd run two
      // recognizers. The processing chain re-arms after it finishes.
      if (handsFreeProcessing) return;
      // Auto-restart with short delay so rapid error cycles don't hammer.
      window.setTimeout(() => {
        if (handsFreeActive && !handsFreeProcessing) armOnce();
      }, 120);
    };

    try {
      recognition.start();
    } catch (e) {
      logger.warn('voice', 'hands-free start() threw', {
        err: e instanceof Error ? e.message : String(e),
      });
      clearHandsFreeSession('start-threw');
    }
  };

  armOnce();
}

/**
 * Stop the hands-free listening session. Plays the sleep beep and
 * clears the auto-restart loop. Safe to call mid-recognition (no-op
 * if not currently hands-free).
 */
export function stopHandsFree(): void {
  if (!handsFreeActive) return;

  // Log session duration BEFORE the secondary info log so the STOP log
  // (with ms timer) lands first in the stream — easier to find when
  // scanning for "how long did that hands-free session run."
  clearHandsFreeSession('user-stopped');
  logger.info('voice', 'hands-free stopping');

  const r = activeRecognition;
  if (r) {
    try {
      r.stop();
    } catch {
      // already stopped
    }
  }

  // Sleep beep, but only if we WERE actually listening.
  playBeep('sleep');
  listeningFlag = false;
}

/** True iff a hands-free session is currently armed AND a recognizer is live. */
export function isHandsFreeRecognitionLive(): boolean {
  return handsFreeActive && activeRecognition !== null;
}

/** True iff a hands-free session is currently armed. */
export function isHandsFreeActive(): boolean {
  return handsFreeActive;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** True iff currently listening (guards double-activation on rapid Alt+D). */
export function isListening(): boolean {
  return listeningFlag;
}

/** True iff speechSynthesis is currently speaking. */
export function isSpeaking(): boolean {
  return speakingFlag;
}

/**
 * Immediately cancel any ongoing TTS speech and clear the speaking flag.
 *
 * INTENTIONAL cancel(): This is a user-initiated interrupt (Alt+D or
 * double-ESC while Diamond is speaking). cancel() wipes the shared
 * speechSynthesis queue, which also silences any concurrent screen-reader
 * speech (NVDA/JAWS/VoiceOver). This is the unavoidable cost of Chrome
 * not providing a per-utterance cancel API. Consistent with the existing
 * read-aloud stop in activateDiamond (content.ts:388-389).
 */
export function stopSpeaking(): void {
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  speakingFlag = false;
}

// ---------------------------------------------------------------------------
// Sleep timer
// ---------------------------------------------------------------------------

/**
 * Reset the sleep timer. Clears any existing timer and sets a new 60s
 * timeout. When the timer fires, Diamond plays a sleep beep and marks
 * itself as not listening.
 *
 * Call on: activation, any voice activity (result, interim transcript).
 */
export function resetSleepTimer(): void {
  if (sleepTimerId !== null) {
    clearTimeout(sleepTimerId);
    sleepTimerId = null;
  }

  sleepTimerId = setTimeout(() => {
    playBeep('sleep');
    listeningFlag = false;
    sleepTimerId = null;
  }, 60_000);
}

// ---------------------------------------------------------------------------
// Internal cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up recognition state.
 * @param stoppedByResult - true if recognition ended normally (onresult)
 */
function cleanup(stoppedByResult: boolean): void {
  listeningFlag = false;

  // If recognition ended normally (result received), stop() was already
  // called by onspeechend. Otherwise (error), call stop() to clean up.
  if (!stoppedByResult) {
    const r = activeRecognition;
    if (r) {
      try {
        r.stop();
      } catch {
        // May throw if already stopped — safe to ignore
      }
    }
  }

  activeRecognition = null;
}

// ---------------------------------------------------------------------------
// Safety hooks
// ---------------------------------------------------------------------------

/**
 * One-shot document.visibilitychange listener: if the tab becomes hidden
 * (user switched tabs / minimized the window) while a recognizer is
 * armed, stop it so the mic is not silently listening in a background
 * tab. For a hands-free session we additionally clear the loop so we
 * don't auto-restart into a tab the user can't see — they re-activate
 * with Alt+D when they return.
 *
 * Guardrail: install at most once per module instance. The lazy
 * `ensureVisibilityHook()` call inside startListening / startHandsFree
 * covers all entry points without polluting global state at import
 * time (vitest with resetModules re-imports the module per test, and
 * re-installing would simply no-op via the flag).
 */
let visibilityHookInstalled = false;

function ensureVisibilityHook(): void {
  if (visibilityHookInstalled) return;
  if (typeof document === 'undefined') return;
  visibilityHookInstalled = true;
  document.addEventListener('visibilitychange', onVisibilityChange);
}

/**
 * Visibilitychange handler — stops the live recognizer on tab-hide.
 * Safe to call when no recognizer is active: it just no-ops.
 */
function onVisibilityChange(): void {
  if (typeof document === 'undefined') return;
  if (document.visibilityState !== 'hidden') return;

  const r = activeRecognition;
  if (r) {
    try {
      r.stop();
    } catch {
      // already stopped — ignore (matches cleanup()'s tolerant pattern)
    }
  }

  // For a hands-free session we also exit the loop. The pending `onend`
  // from r.stop() will see handsFreeActive=false and skip the
  // auto-restart, so we don't burn a recognizer in a background tab.
  if (handsFreeActive) {
    clearHandsFreeSession('tab-hidden');
  }
}

// ---------------------------------------------------------------------------
// Text utilities for TTS (Hardening)
// ---------------------------------------------------------------------------

/** Maximum characters per TTS chunk. Conservative — typical Chrome /
 *  Safari TTS engines cap utterances around ~1k chars; 480 leaves head
 *  room while still catching most LLM page-summary outputs in 2-3
 *  utterances. */
const MAX_TTS_CHUNK_CHARS = 480;

/**
 * Strip zero-width unicode and control characters that TTS reads aloud
 * oddly (zero-width spaces, byte-order marks, soft hyphens, C0 control
 * codes except \n/\r/\t which \s+ collapse handles in
 * stripSpokenMarkdown). Pure defensive pass — unaware of any model
 * behavior, just removes invisible / non-printable bytes.
 */
function sanitizeTextForTTS(text: string): string {
  if (!text) return text;
  return text
    .replace(/[\u200B-\u200F\uFEFF\u00AD]/g, '') // zero-width chars + soft hyphen + BOM
    // Control chars except \n \r \t (handled by whitespace collapse).
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
}

/**
 * Strip stray HTML tags like `<b>`, `</b>`, `<a href="...">`. TTS otherwise
 * reads them literally as "less than b greater than". Conservative —
 * strips any `<` that begins with an ASCII letter and any `</...>`. Does
 * NOT strip spans / divs / script content — the LLM is told to produce
 * prose, this is a defense-net for when it doesn't.
 */
function stripHtmlTags(text: string): string {
  if (!text) return text;
  return text.replace(/<\/?[a-zA-Z][^>\n]*>/g, '');
}

/**
 * Strip markdown links `[text](url)` → `text`. The spoken copy should be
 * the link's prose, not the URL — TTS would otherwise pronounce every
 * percent-encoded character ("%20" → "percent twenty"). Doesn't touch
 * bare `<a href="...">` since stripHtmlTags handles those.
 */
function stripMarkdownLinks(text: string): string {
  if (!text) return text;
  return text.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '$1');
}

/**
 * Split a long TTS payload into ≤ `maxChars` chunks at sentence
 * boundaries (priority order: quoted period/exclam/question, plain
 * terminator, comma, last space, hard cut).
 *
 * Example (maxChars=20):
 *   "Hello world. This is sentence two. Bye."
 *   → ["Hello world.", "This is sentence two.", "Bye."]
 *
 * The chunker preserves the existing single-call behavior for short
 * input: it returns `[text]` whenever `text.length <= maxChars`, so
 * the outer speak() path keeps its single-utterance shape for typical
 * page-summary outputs.
 */
function chunkTextForTTS(
  text: string,
  maxChars: number = MAX_TTS_CHUNK_CHARS,
): string[] {
  if (text.length <= maxChars) return [text];

  // Try sentence boundaries in priority order. Each separator's last
  // occurrence within the slice wins; longer matches (`."` over `.`)
  // are checked first so quoted endings stay attached to the chunk.
  const sentenceSeps = ['." ', '!" ', '?" ', '.\n', '!\n', '?\n', '. ', '! ', '? '];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    const slice = remaining.slice(0, maxChars);
    let cutAt = -1;

    for (const sep of sentenceSeps) {
      const idx = slice.lastIndexOf(sep);
      if (idx > cutAt) cutAt = idx + sep.length;
    }

    if (cutAt <= 0) {
      // No sentence break — try a comma (with trailing space).
      const commaIdx = slice.lastIndexOf(', ');
      if (commaIdx > 0) cutAt = commaIdx + 2;
    }

    if (cutAt <= 0) {
      // No punctuation within the slice — split on the last space.
      const spaceIdx = slice.lastIndexOf(' ');
      cutAt = spaceIdx > 0 ? spaceIdx : maxChars;
    }

    const chunk = remaining.slice(0, cutAt).trim();
    if (chunk.length > 0) chunks.push(chunk);
    remaining = remaining.slice(cutAt).trimStart();

    // Safety net: if the loop somehow doesn't make progress (shouldn't
    // happen but a paranoid limit prevents an infinite spin during
    // pathological input).
    if (remaining.length === 0) break;
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
