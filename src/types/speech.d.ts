/**
 * Ambient type declarations for Web Speech API and AudioContext.
 *
 * SpeechRecognition types are not in the default TS DOM lib (they're
 * vendor-prefixed and experimental). AudioContext is standard but we
 * declare it here to avoid issues in the vitest/jsdrom environment.
 *
 * These cover the subset Diamond uses:
 *   - SpeechRecognition (cloud + on-device via processLocally)
 *   - SpeechRecognition.available() / .install() (Chrome 139+ experimental)
 *   - SpeechSynthesisUtterance + speechSynthesis
 *   - AudioContext for beep generation
 */

// ---------------------------------------------------------------------------
// SpeechRecognition
// ---------------------------------------------------------------------------

interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error:
    | 'network'
    | 'not-allowed'
    | 'service-not-allowed'
    | 'no-speech'
    | 'aborted'
    | 'audio-capture'
    | 'bad-grammar'
    | 'language-not-supported';
  readonly message: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;

  /** Chrome 139+ experimental: true = on-device, false = cloud. */
  processLocally?: boolean;

  start(): void;
  stop(): void;
  abort(): void;

  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onspeechend: (() => void) | null;
  onnomatch: (() => void) | null;
  onaudiostart: (() => void) | null;
  onaudioend: (() => void) | null;
  onsoundstart: (() => void) | null;
  onsoundend: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
}

interface SpeechRecognitionStatic {
  new (): SpeechRecognition;

  /** Chrome 139+ experimental: check on-device availability. */
  available?(options: {
    langs: string[];
    processLocally?: boolean;
    quality?: 'command' | 'dictation' | 'conversation';
  }): Promise<'available' | 'downloadable' | 'downloading' | 'unavailable'>;

  /** Chrome 139+ experimental: download language pack for on-device mode. */
  install?(options: {
    langs: string[];
    processLocally?: boolean;
    quality?: 'command' | 'dictation' | 'conversation';
  }): Promise<boolean>;
}

declare var SpeechRecognition: SpeechRecognitionStatic | undefined;
declare var webkitSpeechRecognition: SpeechRecognitionStatic | undefined;

// ---------------------------------------------------------------------------
// SpeechSynthesis (subset — standard TS DOM lib covers most)
// ---------------------------------------------------------------------------

interface SpeechSynthesisUtterance {
  voice: SpeechSynthesisVoice | null;
}

interface SpeechSynthesisVoice {
  readonly localService: boolean;
}

// ---------------------------------------------------------------------------
// AudioContext
// ---------------------------------------------------------------------------

interface AudioContext {
  createOscillator(): OscillatorNode;
  createGain(): GainNode;
  readonly state: AudioContextState;
  close(): Promise<void>;
  resume(): Promise<void>;
}

interface OscillatorNode extends AudioNode {
  type: OscillatorType;
  frequency: AudioParam;
  connect(destination: AudioNode, output?: number, input?: number): AudioNode;
  start(when?: number): void;
  stop(when?: number): void;
}

interface GainNode extends AudioNode {
  gain: AudioParam;
}

interface AudioParam {
  value: number;
  setValueAtTime(value: number, startTime: number): AudioParam;
  linearRampToValueAtTime(value: number, endTime: number): AudioParam;
}

declare var AudioContext: {
  new (): AudioContext;
} | undefined;
