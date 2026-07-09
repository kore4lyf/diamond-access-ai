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
 *   - LLM prompt/response bodies are NEVER logged. Only prompt-length, model,
 *     and response-length are logged.
 *
 * Architecture:
 *   - Pure module. No chrome.* imports — usable from background, content,
 *     voice, and pure-function modules alike.
 *   - One ring buffer per script instance. SW and content each have their
 *     own. (Cross-process consolidation could be added later via storage.)
 *   - Always-on. No `import.meta.env.DEV` gate (we don't want to leak Vite
 *     env vars into the bundle — see Phase I fix).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogCategory =
  | 'user'
  | 'command'
  | 'page_load'
  | 'vlm'
  | 'llm_request'
  | 'llm_response'
  | 'stt'
  | 'tts'
  | 'action'
  | 'safety_net'
  | 'confirm'
  | 'profile'
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

/** Push a log entry (and mirror to browser console). */
export function log(
  level: LogLevel,
  cat: LogCategory,
  msg: string,
  data?: Record<string, unknown>,
): void {
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
