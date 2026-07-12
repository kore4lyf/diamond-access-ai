/**
 * Diamond Access AI — Interrupt Gesture Tests (content script)
 *
 * Black-box tests for the "interrupt Diamond mid-speech" feature
 * (Alt+D talk-over + double-ESC stop). These encode the acceptance
 * criteria from the interrupt plan. They are RED until the developer
 * implements:
 *   - voice.ts:  export isSpeaking() + stopSpeaking() (sets/resets the flag,
 *                calls speechSynthesis.cancel())
 *   - content.ts: import { isSpeaking, stopSpeaking } from '../lib/voice'
 *                 and the two gesture changes:
 *                   (a) activateDiamond(): the interrupt branch runs BEFORE
 *                       the isProcessing guard:
 *                         if (isSpeaking() || isReadingAloud) {
 *                           stopSpeaking(); startFreshSession(); return;
 *                         }
 *                       (no spoken "Stopped reading." blip)
 *                   (b) a capture-phase double-ESC keydown listener mirroring
 *                       the Alt+D form-field guard, which stops speech
 *                       (stop-only) when a 2nd ESC lands within ~400ms.
 *
 * Preconditions / assumptions:
 *   - wxt's defineContentScript is mocked below so the content-script
 *     callback runs in-jsdom, attaching the window keydown listeners.
 *   - `SpeechRecognition` is mocked to record construction and NOT
 *     auto-fire (so a started session stays pending — no real STT/LLM).
 *   - The double-ESC window test assumes Date.now()-based timing. If the
 *     implementation uses performance.now(), widen vi.useFakeTimers() to
 *     include 'performance'.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Run the content-script main() callback instead of handing it to WXT.
vi.mock('wxt/utils/define-content-script', () => ({
  defineContentScript: (options: { main?: () => void }) => {
    options.main?.();
    return options;
  },
}));

type VoiceModule = typeof import('../../lib/voice');

let voice: VoiceModule;
let speechRecognitionCtor: ReturnType<typeof vi.fn>;

function makeChromeStub() {
  return {
    runtime: {
      onMessage: {
        addListener: vi.fn(),
        sendMessage: vi.fn(() => Promise.resolve()),
      },
      sendMessage: vi.fn(() => Promise.resolve()),
    },
    storage: {
      local: {
        get: vi.fn(() => Promise.resolve({})),
        set: vi.fn(() => Promise.resolve()),
      },
    },
    tabs: {
      query: vi.fn(() => Promise.resolve([])),
      sendMessage: vi.fn(() => Promise.resolve()),
    },
  };
}

function setupAudioMocks(): void {
  const makeAudioContext = () => ({
    state: 'running' as const,
    currentTime: 0,
    destination: {},
    createOscillator: vi.fn(() => ({
      type: '',
      frequency: { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    })),
    createGain: vi.fn(() => ({
      gain: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    })),
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  });
  vi.stubGlobal('AudioContext', vi.fn(makeAudioContext));

  vi.stubGlobal('speechSynthesis', {
    getVoices: vi.fn(() => []),
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

function setupNoAutoFireSR(): void {
  speechRecognitionCtor = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.continuous = false;
    this.interimResults = false;
    this.lang = '';
    this.start = vi.fn();
    this.stop = vi.fn();
    this.abort = vi.fn();
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this.onspeechend = null;
  });
  vi.stubGlobal('SpeechRecognition', speechRecognitionCtor);
  vi.stubGlobal('webkitSpeechRecognition', undefined);
}

function key(code: string, opts: Record<string, unknown> = {}): KeyboardEvent {
  // The handlers key on `e.code` (Alt+D/Alt+S) and `e.key` (double-ESC),
  // so default `key` to `code` unless the caller overrides it.
  return new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    code,
    key: (opts.key as string) ?? code,
    ...opts,
  } as KeyboardEventInit);
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const speakMock = () => vi.mocked(speechSynthesis.speak as unknown as ReturnType<typeof vi.fn>);
const cancelMock = () => vi.mocked(speechSynthesis.cancel as unknown as ReturnType<typeof vi.fn>);

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('chrome', makeChromeStub());
  setupAudioMocks();
  setupNoAutoFireSR();

  vi.resetModules();
  voice = await vi.importActual<VoiceModule>('../../lib/voice');
  // Importing the entrypoint runs defineContentScript → attaches the
  // window keydown listeners we drive below.
  await import('../../entrypoints/content');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Alt+D — talk over Diamond', () => {
  it('while speaking: cancels speech, starts a fresh session, and emits no spoken blip', async () => {
    const p = voice.speak('Reply in progress');
    expect(voice.isSpeaking()).toBe(true);

    const speaksBefore = speakMock().mock.calls.length;

    window.dispatchEvent(key('KeyD', { altKey: true }));
    await tick();

    expect(cancelMock()).toHaveBeenCalled(); // stopSpeaking()
    expect(speechRecognitionCtor.mock.calls.length).toBeGreaterThanOrEqual(1); // fresh session
    expect(speakMock().mock.calls.length).toBe(speaksBefore); // no "Stopped reading." blip

    // Settle the interrupted utterance so the test leaves no dangling promise.
    const utter = speakMock().mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    (utter?.onend as (() => void) | null)?.();
    await p;
  });

  it('while idle: starts a normal session without canceling', async () => {
    window.dispatchEvent(key('KeyD', { altKey: true }));
    await tick();

    expect(speechRecognitionCtor.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(cancelMock()).not.toHaveBeenCalled();
  });

  it('inside a form field: DOES interrupt (Alt+D is a chord, not literal text)', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);

    voice.speak('Reply in progress'); // isSpeaking true
    const sessionsBefore = speechRecognitionCtor.mock.calls.length;
    input.dispatchEvent(key('KeyD', { altKey: true }));
    await tick();

    expect(cancelMock()).toHaveBeenCalled();
    expect(speechRecognitionCtor.mock.calls.length).toBe(sessionsBefore + 1);
  });
});

describe('Double ESC — stop speech', () => {
  it('within the window: stops speech (stop-only, no new session)', async () => {
    voice.speak('Reply in progress'); // isSpeaking true
    const sessionsBefore = speechRecognitionCtor.mock.calls.length;

    window.dispatchEvent(key('Escape'));
    window.dispatchEvent(key('Escape')); // 2nd press, same tick → within window
    await tick();

    expect(cancelMock()).toHaveBeenCalled();
    expect(speechRecognitionCtor.mock.calls.length).toBe(sessionsBefore); // no new session
  });

  it('outside the ~400ms window: does NOT stop', async () => {
    voice.speak('Reply in progress'); // isSpeaking true

    window.dispatchEvent(key('Escape'));
    vi.advanceTimersByTime(500); // move Date.now forward past the window
    window.dispatchEvent(key('Escape'));
    await tick();

    expect(cancelMock()).not.toHaveBeenCalled();
  });

  it('inside a form field: does NOT stop', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);

    voice.speak('Reply in progress'); // isSpeaking true
    input.dispatchEvent(key('Escape'));
    input.dispatchEvent(key('Escape'));
    await tick();

    expect(cancelMock()).not.toHaveBeenCalled();
  });
});
