/**
 * Diamond Access AI — Voice Pipeline Tests
 *
 * Phase D: Unit tests for playBeep, speak, startListening, isListening,
 * resetSleepTimer. All Web Speech APIs and AudioContext are mocked —
 * jsdom has none of them.
 *
 * Per DOC-VOICE-STANDARDS §1.1:
 *   Mock all speech/audio APIs in unit tests. The single sanctioned live
 *   test is doc/PC-QA-TEST.md §Phase D (PC only, real mic + speakers).
 *
 * NOTE: vi.resetModules() + dynamic import in beforeEach ensures each test
 * gets fresh module state (AudioContext singleton, listeningFlag, etc.).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type VoiceModule = typeof import('../voice');

// ---------------------------------------------------------------------------
// Mock factories — each call returns fresh objects
// ---------------------------------------------------------------------------

function buildMockOscillator() {
  return {
    type: '',
    frequency: {
      value: 0,
      setValueAtTime: vi.fn().mockReturnThis(),
      linearRampToValueAtTime: vi.fn().mockReturnThis(),
    },
    connect: vi.fn().mockReturnThis(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

function buildMockGain() {
  return {
    gain: {
      value: 0,
      setValueAtTime: vi.fn().mockReturnThis(),
      exponentialRampToValueAtTime: vi.fn().mockReturnThis(),
    },
    connect: vi.fn().mockReturnThis(),
  };
}

/** Setup all required global mocks. */
function setupGlobalMocks(): void {
  // --- AudioContext mock ---
  const makeAudioContext = () => ({
    state: 'running' as const,
    currentTime: 0,
    destination: {},
    createOscillator: vi.fn(buildMockOscillator),
    createGain: vi.fn(buildMockGain),
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  });

  vi.stubGlobal(
    'AudioContext',
    vi.fn(function () {
      return makeAudioContext();
    }),
  );

  // --- SpeechSynthesis mock ---
  const voices = [
    {
      name: 'Test US Female',
      lang: 'en-US',
      localService: true,
      default: false,
      voiceURI: 'test-us-female',
    },
    {
      name: 'Test US Male',
      lang: 'en-US',
      localService: false,
      default: true,
      voiceURI: 'test-us-male',
    },
  ];

  vi.stubGlobal('speechSynthesis', {
    getVoices: vi.fn(() => voices),
    speak: vi.fn(),
    cancel: vi.fn(),
    paused: false,
    pending: false,
    speaking: false,
    onvoiceschanged: null,
  });

  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    vi.fn(function (this: Record<string, unknown>, text: string) {
      this.text = text;
      this.rate = 1.0;
      this.pitch = 1.0;
      this.volume = 1.0;
      this.voice = null;
      this.onend = null;
      this.onerror = null;
    }),
  );
}

/** Setup default SpeechRecognition mock (fires onresult after microtask). */
function setupDefaultSpeechRecognition(): void {
  const recognition: Record<string, unknown> = {
    continuous: false,
    interimResults: false,
    lang: '',
    processLocally: undefined,
    start: vi.fn().mockImplementation(function (this: typeof recognition) {
      Promise.resolve().then(() => {
        if (typeof this.onresult === 'function') {
          (this.onresult as (e: SpeechRecognitionEvent) => void)({
            results: [[{ transcript: 'test transcript', confidence: 0.9 }]],
            resultIndex: 0,
          } as unknown as SpeechRecognitionEvent);
        }
      });
    }),
    stop: vi.fn(),
    abort: vi.fn(),
    onresult: null as unknown,
    onerror: null as unknown,
    onend: null as unknown,
    onspeechend: null as unknown,
  };

  vi.stubGlobal(
    'SpeechRecognition',
    vi.fn(function () {
      return recognition;
    }) as unknown,
  );
  vi.stubGlobal('webkitSpeechRecognition', undefined);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let mod: VoiceModule;

beforeEach(async () => {
  vi.useFakeTimers();
  setupGlobalMocks();
  setupDefaultSpeechRecognition();

  vi.resetModules();
  mod = await vi.importActual<VoiceModule>('../voice');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helper — last utterance passed to speechSynthesis.speak
// ---------------------------------------------------------------------------

function lastUtterance(): Record<string, unknown> | undefined {
  const call = vi.mocked(speechSynthesis.speak).mock.lastCall;
  return call?.[0] as Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Smoke
// ---------------------------------------------------------------------------

describe('smoke', () => {
  it('all exports exist', () => {
    expect(mod.playBeep).toBeDefined();
    expect(mod.speak).toBeDefined();
    expect(mod.startListening).toBeDefined();
    expect(mod.isListening).toBeDefined();
    expect(mod.resetSleepTimer).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// playBeep
// ---------------------------------------------------------------------------

describe('playBeep', () => {
  it('awak beep uses 880Hz oscillator', () => {
    mod.playBeep('awake');

    const AC = vi.mocked(AudioContext!);
    expect(AC).toHaveBeenCalledTimes(1);

    const ctx = AC.mock.results[0]?.value as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    expect(ctx.createOscillator).toHaveBeenCalledTimes(1);
    const osc: Record<string, unknown> = (
      ctx.createOscillator as ReturnType<typeof vi.fn>
    ).mock.results[0]?.value as Record<string, unknown>;
    expect(osc.type).toBe('sine');
    const freqSet = (
      osc.frequency as { setValueAtTime: ReturnType<typeof vi.fn> }
    ).setValueAtTime;
    expect(freqSet).toHaveBeenCalledWith(880, 0);
  });

  it('sleep beep uses 440Hz oscillator', () => {
    mod.playBeep('sleep');

    const AC = vi.mocked(AudioContext!);
    expect(AC).toHaveBeenCalledTimes(1);

    const ctx = AC.mock.results[0]?.value as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    expect(ctx.createOscillator).toHaveBeenCalledTimes(1);
    const osc: Record<string, unknown> = (
      ctx.createOscillator as ReturnType<typeof vi.fn>
    ).mock.results[0]?.value as Record<string, unknown>;
    const freqSet = (
      osc.frequency as { setValueAtTime: ReturnType<typeof vi.fn> }
    ).setValueAtTime;
    expect(freqSet).toHaveBeenCalledWith(440, 0);
  });

  it('creates a gain node with exponential ramp', () => {
    mod.playBeep('awake');

    const AC = vi.mocked(AudioContext!);
    const ctx = AC.mock.results[0]?.value as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    expect(ctx.createGain).toHaveBeenCalledTimes(1);

    const gain: Record<string, unknown> = (
      ctx.createGain as ReturnType<typeof vi.fn>
    ).mock.results[0]?.value as Record<string, unknown>;

    const gainSet = (
      gain.gain as { setValueAtTime: ReturnType<typeof vi.fn> }
    ).setValueAtTime;
    const gainRamp = (
      gain.gain as {
        exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
      }
    ).exponentialRampToValueAtTime;

    expect(gainSet).toHaveBeenCalledWith(0.3, 0);
    expect(gainRamp).toHaveBeenCalledWith(0.01, 0.15);
  });

  it('does not crash when AudioContext is undefined', () => {
    vi.stubGlobal('AudioContext', undefined);

    expect(() => mod.playBeep('awake')).not.toThrow();
    expect(() => mod.playBeep('sleep')).not.toThrow();
  });

  it('reuses singleton AudioContext across multiple calls', () => {
    mod.playBeep('awake');
    mod.playBeep('sleep');
    mod.playBeep('awake');

    const AC = vi.mocked(AudioContext!);
    expect(AC).toHaveBeenCalledTimes(1); // Singleton
  });
});

// ---------------------------------------------------------------------------
// speak
// ---------------------------------------------------------------------------

describe('speak', () => {
  it('resolves after utterance onend', async () => {
    const promise = mod.speak('Hello');

    const utter = lastUtterance();
    expect(utter).toBeDefined();
    const onend = utter?.onend as (() => void) | null;
    onend?.();

    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves on utterance onerror (does not block)', async () => {
    const promise = mod.speak('Hello');

    const utter = lastUtterance();
    expect(utter).toBeDefined();
    const onerror = utter?.onerror as (() => void) | null;
    onerror?.();

    await expect(promise).resolves.toBeUndefined();
  });

  it('sets rate, pitch, and volume to 1.0', () => {
    mod.speak('Test');
    const utter = lastUtterance();
    expect(utter?.rate).toBe(1.0);
    expect(utter?.pitch).toBe(1.0);
    expect(utter?.volume).toBe(1.0);
  });

  it('prefers localService en-US voice', () => {
    mod.speak('Test');
    const utter = lastUtterance();
    const voice = utter?.voice as { name: string } | null;
    expect(voice?.name).toBe('Test US Female');
  });

  it('falls back when no en-US voice', () => {
    vi.stubGlobal('speechSynthesis', {
      getVoices: vi.fn(() => [
        { name: 'French', lang: 'fr-FR', localService: true },
      ]),
      speak: vi.fn(),
      cancel: vi.fn(),
      paused: false,
      pending: false,
      speaking: false,
    });

    mod.speak('Test');
    const utter = lastUtterance();
    const voice = utter?.voice as { name: string } | null;
    expect(voice?.name).toBe('French');
  });

  it('does not crash when speechSynthesis is unavailable', async () => {
    vi.stubGlobal('speechSynthesis', undefined);
    vi.stubGlobal('SpeechSynthesisUtterance', undefined);

    await expect(mod.speak('Hello')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// startListening
// ---------------------------------------------------------------------------

describe('startListening', () => {
  it('creates SpeechRecognition and calls start', () => {
    mod.startListening();

    const SR = vi.mocked(SpeechRecognition!);
    expect(SR).toHaveBeenCalledTimes(1);
    const rec = SR.mock.results[0]?.value as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    expect(rec.start).toHaveBeenCalledTimes(1);
  });

  it('sets continuous=false, interimResults=false, lang=en-US', () => {
    mod.startListening();

    const SR = vi.mocked(SpeechRecognition!);
    const rec = SR.mock.results[0]?.value as Record<string, unknown>;
    expect(rec.continuous).toBe(false);
    expect(rec.interimResults).toBe(false);
    expect(rec.lang).toBe('en-US');
  });

  it('resolves with the transcript on speech result', async () => {
    const result = await mod.startListening();
    expect(result).toBe('test transcript');
  });

  it('isListening reflects state', async () => {
    expect(mod.isListening()).toBe(false);

    const promise = mod.startListening();
    expect(mod.isListening()).toBe(true);

    await promise;
    expect(mod.isListening()).toBe(false);
  });

  it('resolves empty on no-speech error', async () => {
    const recognition: Record<string, unknown> = {
      continuous: false,
      interimResults: false,
      lang: '',
      start: vi.fn().mockImplementation(function (this: typeof recognition) {
        Promise.resolve().then(() => {
          if (typeof this.onerror === 'function') {
            (this.onerror as (e: SpeechRecognitionErrorEvent) => void)({
              error: 'no-speech',
              message: 'No speech',
            } as unknown as SpeechRecognitionErrorEvent);
          }
        });
      }),
      stop: vi.fn(),
      abort: vi.fn(),
      onresult: null,
      onerror: null,
      onspeechend: null,
    };

    vi.stubGlobal(
      'SpeechRecognition',
      vi.fn(function () {
        return recognition;
      }),
    );

    vi.resetModules();
    mod = await vi.importActual<VoiceModule>('../voice');

    const result = await mod.startListening();
    expect(result).toBe('');
  });

  it('handles network error — speaks and resolves empty', async () => {
    const recognition: Record<string, unknown> = {
      continuous: false,
      interimResults: false,
      lang: '',
      start: vi.fn().mockImplementation(function (this: typeof recognition) {
        Promise.resolve().then(() => {
          if (typeof this.onerror === 'function') {
            (this.onerror as (e: SpeechRecognitionErrorEvent) => void)({
              error: 'network',
              message: 'Network error',
            } as unknown as SpeechRecognitionErrorEvent);
          }
        });
      }),
      stop: vi.fn(),
      abort: vi.fn(),
      onresult: null,
      onerror: null,
      onspeechend: null,
    };

    vi.stubGlobal(
      'SpeechRecognition',
      vi.fn(function () {
        return recognition;
      }),
    );

    vi.resetModules();
    mod = await vi.importActual<VoiceModule>('../voice');

    const result = await mod.startListening();
    expect(result).toBe('');

    const utter = lastUtterance();
    expect(utter?.text).toContain('check your connection');
  });

  it('falls back when SpeechRecognition unavailable', async () => {
    vi.stubGlobal('SpeechRecognition', undefined);
    vi.stubGlobal('webkitSpeechRecognition', undefined);

    vi.resetModules();
    mod = await vi.importActual<VoiceModule>('../voice');

    const result = await mod.startListening();
    expect(result).toBe('');
  });

  it('no-ops when already listening', async () => {
    const promise1 = mod.startListening();
    const SR = vi.mocked(SpeechRecognition!);
    const rec = SR.mock.results[0]?.value as Record<
      string,
      ReturnType<typeof vi.fn>
    >;

    await expect(mod.startListening()).resolves.toBe('');
    expect(rec.start).toHaveBeenCalledTimes(1);

    await promise1;
  });
});

// ---------------------------------------------------------------------------
// isListening
// ---------------------------------------------------------------------------

describe('isListening', () => {
  it('returns false initially', () => {
    expect(mod.isListening()).toBe(false);
  });

  it('returns true while listening, false after', async () => {
    expect(mod.isListening()).toBe(false);

    const promise = mod.startListening();
    expect(mod.isListening()).toBe(true);

    await promise;
    expect(mod.isListening()).toBe(false);
  });

  it('stays false when startListening returns immediately', async () => {
    vi.stubGlobal('SpeechRecognition', undefined);
    vi.stubGlobal('webkitSpeechRecognition', undefined);

    vi.resetModules();
    mod = await vi.importActual<VoiceModule>('../voice');

    expect(mod.isListening()).toBe(false);
    await mod.startListening();
    expect(mod.isListening()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resetSleepTimer
// ---------------------------------------------------------------------------

describe('resetSleepTimer', () => {
  it('does not stack timers when called multiple times', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    mod.resetSleepTimer();
    mod.resetSleepTimer();
    mod.resetSleepTimer();

    // 1st call: setTimeout ×1; 2nd: clearTimeout ×1 + setTimeout ×1;
    // 3rd: clearTimeout ×1 + setTimeout ×1 → 2 clearTimeout calls
    expect(clearSpy).toHaveBeenCalledTimes(2);
  });

  it('fires sleep beep after 60s and sets isListening false', async () => {
    const promise = mod.startListening();
    expect(mod.isListening()).toBe(true);

    mod.resetSleepTimer();

    vi.advanceTimersByTime(60_000);

    expect(mod.isListening()).toBe(false);

    await promise;
  });

  it('does not fire before 60s', () => {
    mod.resetSleepTimer();
    vi.advanceTimersByTime(59_000);

    expect(mod.isListening()).toBe(false);
  });
});
