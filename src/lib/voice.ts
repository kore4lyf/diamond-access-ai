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
            }
          })
          .catch(() => {
            // Silently fall back to cloud
          });
      }
    }

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = event.results[0][0].transcript ?? '';
      cleanup(true);
      resetSleepTimer();
      resolve(transcript);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      const error = event.error;

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
      recognition.stop();
    };

    recognition.start();
  });
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
