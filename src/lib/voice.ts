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
 *   - No speechSynthesis.cancel() — shared queue with screen readers
 *   - No getUserMedia — browser handles mic prompt on recognition.start()
 *   - No new permissions (still ["activeTab","storage"])
 *   - Singleton AudioContext — do not create one per beep
 *   - isListening() guard prevents double-activation
 *   - Sleep timeout 60s — any voice activity resets it
 */

import { ERRORS } from './errors';
import * as logger from './logger';

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

/** Restart counter — guards against tight error-restart loops. */
let handsFreeRestartCount = 0;
const HANDS_FREE_MAX_RESTARTS_WITHOUT_RESULT = 8;

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
 * Resolves on `onend` or `onerror` — never blocks on TTS failure.
 *
 * Voice selection priority:
 *   1. localService === true && lang === 'en-US'
 *   2. lang === 'en-US'
 *   3. voices[0] (fallback)
 *
 * HARD RULE: Do NOT call speechSynthesis.cancel(). It shares the queue with
 * screen readers (NVDA/JAWS/VoiceOver). Just utter — let the queue sequence
 * naturally.
 */
export function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (
      typeof speechSynthesis === 'undefined' ||
      typeof SpeechSynthesisUtterance === 'undefined'
    ) {
      console.log('[Diamond] speechSynthesis not available');
      resolve();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    // Select best available voice
    const voices = speechSynthesis.getVoices();
    const preferred =
      voices.find((v) => v.lang === 'en-US' && v.localService) ??
      voices.find((v) => v.lang === 'en-US') ??
      voices[0] ??
      null;

    if (preferred) {
      utterance.voice = preferred;
    }

    utterance.onend = () => resolve();
    utterance.onerror = () => resolve(); // Don't block on TTS errors

    // Chrome loads voices asynchronously — if none yet, listen for the event
    if (voices.length === 0) {
      speechSynthesis.onvoiceschanged = () => {
        const updatedVoices = speechSynthesis.getVoices();
        const better =
          updatedVoices.find(
            (v) => v.lang === 'en-US' && v.localService,
          ) ??
          updatedVoices.find((v) => v.lang === 'en-US') ??
          updatedVoices[0] ??
          null;
        if (better) utterance.voice = better;
        speechSynthesis.onvoiceschanged = null;
      };
    }

    speechSynthesis.speak(utterance);
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
      } else if (error === 'no-speech') {
        // Silent — resolve with empty transcript
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

    recognition.start();
    logger.info('stt', 'recognition started', {
      lang: recognition.lang,
      processLocally: recognition.processLocally,
    });
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
  // Guard: don't double-arm hands-free.
  if (handsFreeActive) {
    logger.warn('voice', 'startHandsFree called while already active');
    return;
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

  playBeep('awake');
  logger.info('voice', 'hands-free started');

  const armOnce = (): void => {
    if (!handsFreeActive) return;

    let recognition: SpeechRecognition;
    try {
      recognition = new SpeechRecognitionCtor();
    } catch (e) {
      logger.error('voice', 'failed to construct recognition in hands-free', {
        err: e instanceof Error ? e.message : String(e),
      });
      handsFreeActive = false;
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

    recognition.onstart = () => {
      logger.debug('stt', 'hands-free session start');
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      handsFreeRestartCount = 0;
      resetSleepTimer();

      // Pick the LAST `isFinal` entry — interim transcripts don't matter.
      let finalTranscript = '';
      for (let i = event.results.length - 1; i >= 0; i--) {
        const result = event.results[i];
        if (result && result.isFinal) {
          finalTranscript = result[0]?.transcript ?? '';
          break;
        }
      }

      if (!finalTranscript) return; // interim only — keep listening.

      logger.info('stt', 'hands-free transcript', {
        text: finalTranscript,
      });

      // Wrap in a Promise chain so sync and async callbacks converge on
      // the same handling. Sync throws become rejections here too.
      Promise.resolve()
        .then(() => onUtterance(finalTranscript))
        .then((keepGoing) => {
          if (keepGoing === false) {
            logger.info('voice', 'utterance callback requested stop');
            handsFreeActive = false;
            try {
              recognition.stop();
            } catch {
              // already stopped
            }
          }
        })
        .catch((err) => {
          logger.error('voice', 'utterance callback threw', {
            err: err instanceof Error ? err.message : String(err),
            transcript: finalTranscript,
          });
          // Sync throw from a buggy callback never breaks the loop —
          // we just continue to the next utterance.
        });
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      handsFreeRestartCount++;
      const error = event.error;
      logger.warn('stt', 'hands-free error', {
        error,
        restartCount: handsFreeRestartCount,
      });

      if (error === 'no-speech') {
        // Expected — onend's auto-restart covers it.
        return;
      }
      if (error === 'not-allowed' || error === 'service-not-allowed') {
        speak(ERRORS.MIC_BLOCKED);
        handsFreeActive = false;
        return;
      }
      if (error === 'network') {
        speak(ERRORS.STT_NETWORK);
        handsFreeActive = false;
        return;
      }
      // Unknown / abort — auto-restart will pick it up if arms remain.
      if (handsFreeRestartCount > HANDS_FREE_MAX_RESTARTS_WITHOUT_RESULT) {
        logger.warn(
          'voice',
          'hands-free aborting after too many restarts without result',
        );
        speak(ERRORS.STT_OTHER);
        handsFreeActive = false;
      }
    };

    recognition.onend = () => {
      listeningFlag = false;
      activeRecognition = null;
      logger.debug('stt', 'hands-free session end', { handsFreeActive });
      if (!handsFreeActive) {
        logger.info('voice', 'hands-free stopped cleanly');
        return;
      }
      // Auto-restart with short delay so rapid error cycles don't hammer.
      window.setTimeout(() => {
        if (handsFreeActive) armOnce();
      }, 120);
    };

    try {
      recognition.start();
    } catch (e) {
      logger.warn('voice', 'hands-free start() threw', {
        err: e instanceof Error ? e.message : String(e),
      });
      handsFreeActive = false;
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

  handsFreeActive = false;
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
