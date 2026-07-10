/**
 * Diamond Access AI — Logger
 *
 * Centralized structured-logging module for development + diagnostics.
 *
 * Goals (locked):
 *   - Observe the full picture: user input, Diamond actions, Diamond responses,
 *     performance (latency), errors, and lifecycle events.
 *   - Provide an in-memory ring buffer (last 500 entries) for diagnostics via
 *     `chrome.runtime.sendMessage({type: 'GET_LOGS'})` and `CLEAR_LOGS`.
 *   - Surface logs through the browser console with a `[Diamond] LEVEL [cat]`
 *     prefix so Chrome's level filter and DevTools "filter by regex" work.
 *
 * Privacy contract:
 *   - User voice transcripts ARE logged in full (you explicitly want this for
 *     dev visibility). Single-user device, console-only — never persisted.
 *   - Form values (passwords, CC, SSN, anything filling) are NEVER logged.
 *     Only the field type ("password", "credit-card", etc.) is logged.
 *   - LLM prompt/response bodies are NEVER logged by default. Only
 *     prompt-length, model, and response-length are logged.
 *     — Phase J + Step B1: an opt-in developer flag
 *       (`diamond_verbose_llm` in chrome.storage.local) flips
 *       `callLLMWithRetry` into dumping the actual response body alongside
 *       the metadata. The flag is off by default; production CRX never
 *       reads it because the `IS_DEV` gate in this file short-circuits
 *       `log()` before reaching the logger.debug() call site.
 *
 * Architecture:
 *   - Pure module. No chrome.* imports — usable from background, content,
 *     voice, and pure-function modules alike.
 *   - One ring buffer per script instance. SW and content each have their
 *     own. (Cross-process consolidation could be added later via storage.)
 *
 * Phase J + Step L — production gating.
 *   The user reported: "Logging is only for development, it shouldn't get
 *   into production." Earlier the logger was always-on (no DEV gate) by
 *   the prior design choice. That has changed. We now check
 *   `import.meta.env?.DEV` and short-circuit the entire `log()` body in
 *   production builds, so:
 *     - The ring buffer stays empty in production (no diagnostic data).
 *     - No console.debug/info/warn/error call site fires (no DevTools noise).
 *   Test runs default to dev (vitest is Vite-transformed; `import.meta.env`
 *   resolves to DEV=true), so green tests imply the gate is working.
 *   Vite's tree-shaker still strips any unreachable branch — the
 *   production CRX comes out with logging effectively gone. The Phase I
 *   "no VITE_FW_KEY in bundle" commit remains valid because Phase I was
 *   about API-key embedding, not about logger gating. These are separate
 *   concerns and the logger gate does not reintroduce the risk.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogCategory =
  | 'user'
  | 'command'
  | 'page_load'
  | 'vlm'
  | 'describe_crop'
  | 'llm_request'
  | 'llm_response'
  | 'stt'
  | 'tts'
  | 'action'
  | 'safety_net'
  | 'confirm'
  | 'profile'
  | 'voice'
  | 'storage'
  | 'system'
  | 'error';

export interface LogEntry {
  /** Unix ms timestamp. */
  ts: number;
  /** Severity. */
  level: LogLevel;
  /** Functional category — useful for filtering. */
  cat: LogCategory;
  /** Human-readable description. Keep short. */
  msg: string;
  /** Optional structured payload. Never include PII. */
  data?: Record<string, unknown>;
}

const BUFFER_MAX = 500;
const TRUNCATE_STRINGS_AT = 240;

/** Per-script instance ring buffer. */
const ringBuffer: LogEntry[] = [];

/**
 * Build-time / run-time check: are we in a development build where full
 * logging is welcome, or a production CRX where the user has explicitly
 * asked for silence? Resolves synchronously at module load.
 *
 * - Production CRX (Vite build): `import.meta.env.DEV === false` → false
 *   → `log()` short-circuits, ring buffer + console both stay empty.
 * - Dev server / unpacked-extension dev mode: `import.meta.env.DEV === true`
 *   → true → `log()` runs the existing path.
 * - Vitest (also vite-transformed): same as dev → true.
 * - Fallback if `import.meta` is undefined or throws: assume true (err on
 *   the side of logging; alternative — assuming false — would silently
 *   break dev when import.meta resolution fails).
 */
const IS_DEV: boolean = (() => {
  try {
    return (
      typeof import.meta !== 'undefined' &&
      (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true
    );
  } catch {
    return true;
  }
})();

/** Push a log entry (and mirror to browser console), gated to dev. */
export function log(
  level: LogLevel,
  cat: LogCategory,
  msg: string,
  data?: Record<string, unknown>,
): void {
  // Step L — production CRX has no business logging. Short-circuit before
  // any work so the ring buffer stays empty and no console mirror fires.
  if (!IS_DEV) return;

  const entry: LogEntry = { ts: Date.now(), level, cat, msg, data };
  ringBuffer.push(entry);
  while (ringBuffer.length > BUFFER_MAX) ringBuffer.shift();

  const dataStr = data ? ' ' + safeStringify(data) : '';
  const line = `[Diamond] ${level.toUpperCase().padEnd(5)} [${cat.padEnd(13)}] ${msg}${dataStr}`;

  switch (level) {
    case 'debug':
      // eslint-disable-next-line no-console
      console.debug(line);
      break;
    case 'info':
      // eslint-disable-next-line no-console
      console.info(line);
      break;
    case 'warn':
      // eslint-disable-next-line no-console
      console.warn(line);
      break;
    case 'error':
      // eslint-disable-next-line no-console
      console.error(line);
      break;
  }
}

/** JSON.stringify with long strings truncated to prevent console spam. */
function safeStringify(data: Record<string, unknown>): string {
  try {
    const cloned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string' && v.length > TRUNCATE_STRINGS_AT) {
        cloned[k] = `${v.slice(0, TRUNCATE_STRINGS_AT)}\u2026(${v.length} chars)`;
      } else if (typeof v === 'function' || typeof v === 'symbol') {
        cloned[k] = String(v);
      } else {
        cloned[k] = v;
      }
    }
    return JSON.stringify(cloned);
  } catch {
    return '[unserializable]';
  }
}

export const debug = (cat: LogCategory, msg: string, data?: Record<string, unknown>) =>
  log('debug', cat, msg, data);

export const info = (cat: LogCategory, msg: string, data?: Record<string, unknown>) =>
  log('info', cat, msg, data);

export const warn = (cat: LogCategory, msg: string, data?: Record<string, unknown>) =>
  log('warn', cat, msg, data);

export const error = (cat: LogCategory, msg: string, data?: Record<string, unknown>) =>
  log('error', cat, msg, data);

/** Read-only snapshot of current buffer (newest entries at the end). */
export function getLogs(): readonly LogEntry[] {
  return ringBuffer.slice();
}

/** Empty the buffer. */
export function clearLogs(): void {
  ringBuffer.length = 0;
}

/**
 * Stopwatch helper — measures elapsed time and emits a single log entry on
 * stop. Use for LLM, STT, action execution timing.
 */
export class Stopwatch {
  private readonly startMs: number;
  constructor(private readonly cat: LogCategory, private readonly label: string) {
    this.startMs = Date.now();
  }
  /** Stop and log; returns elapsed milliseconds. */
  stop(extra?: string): number {
    const elapsed = Date.now() - this.startMs;
    const msg = extra ? `${this.label} (${extra})` : this.label;
    log('debug', this.cat, msg, { ms: elapsed });
    return elapsed;
  }
}
