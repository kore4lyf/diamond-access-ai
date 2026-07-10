/**
 * Diamond Access AI — Fireworks API Client
 *
 * Phase C: Real Fireworks API client replacing the callLLM() stub.
 * Diamond's brain — every command eventually routes through here.
 *
 * Two-tier model ADR:
 *   Dev/MVP: MiniMax M3 (serverless on AMD MI300X via Fireworks)
 *   Production: Gemma 4 31B IT (self-hosted on AMD GPU — NOT our concern here)
 *
 * Architecture (§2 of DOC-FIREWORKS-INTEGRATION):
 *   callLLMCore()       — pure function, no chrome.*, unit-testable with mocked fetch
 *   callLLM()           — wrapper reading key+model from chrome.storage.local
 *   callLLMWithRetry()  — retry + JSON re-prompt wrapper
 *   callVLM()           — stub for Phase E (multimodal)
 *
 * Guardrails:
 *   - Dev model ONLY: accounts/fireworks/models/minimax-m3
 *   - No Gemma references in code, comments, tests, or defaults
 *   - No secrets hardcoded — API key from chrome.storage.local at runtime
 *   - No DOM access, no chrome.* in callLLMCore
 *   - Response shape validated with runtime checks (strict-mode safe)
 */

import * as logger from './logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fireworks chat completions endpoint (OpenAI-compatible). */
export const FIREWORKS_URL =
  'https://api.fireworks.ai/inference/v1/chat/completions';

/**
 * Dev/MVP model ID — the ONLY model we call during development.
 * MiniMax M3, serverless on AMD MI300X via Fireworks.
 *
 * ─────────────────────────────────────────────────────────────────────
 * HARD RULE — PRODUCTION MODEL MUST NEVER APPEAR IN src/
 * ─────────────────────────────────────────────────────────────────────
 * The production model ID (Gemma 4 31B IT) is documented in:
 *   - `doc/DOC-MODEL-ADR.md` §3 — decision rationale
 *   - `doc/DOC-FIREWORKS-INTEGRATION.md` — API specifics
 *   - `doc/TO-PM.md` PM-6 — locked planning
 *
 * The runtime swap to Gemma is a *production release operation*,
 * not a dev toggle. Adding the Gemma model ID here — even as a
 * comment, fallback, or "just in case" branch — would couple our
 * dev defaults to the prod surface. The `diamond_model` key in
 * chrome.storage.local is the single, audited runtime swap path.
 *
 * CI guard (Phase I): `grep -niE 'gemma|akfaleye|t5rv9ps1' src/` MUST
 * return empty (comments are filtered as the QA script does — the
 * dev's guardrail comments here are exempted by an explicit grep
 * pattern in `doc/TO-QA.md` QA-E10).
 * ─────────────────────────────────────────────────────────────────────
 */
export const DEV_MODEL_ID = 'accounts/fireworks/models/minimax-m3';

// ---------------------------------------------------------------------------
// Verbose LLM logging — opt-in PC QA diagnostic
// ---------------------------------------------------------------------------

/**
 * Storage key for the developer-facing "dump LLM response bodies" toggle.
 * When true and the runtime is DEV (Phase L), `callLLMWithRetry` emits a
 * `logger.debug('llm_response', 'body (verbose)', { text })` line per
 * successful response so PC QA diagnostics can read what the Fireworks
 * model actually returned — needed to debug the "page summary reads like
 * JSON" report (Phase J).
 *
 * Default: false. Set via:
 *   chrome.storage.local.set({ diamond_verbose_llm: true })
 * in the SW DevTools console. Remove the key to revert. End users of the
 * production CRX should never need this — the privacy contract still says
 * LLM bodies are NOT logged by default.
 */
const VERBOSE_LLM_KEY = 'diamond_verbose_llm';

/** Read the verbose-LLM flag. Returns false on any failure (privacy default). */
async function isVerboseLlmOn(): Promise<boolean> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return false;
    const r = await chrome.storage.local.get(VERBOSE_LLM_KEY);
    return r[VERBOSE_LLM_KEY] === true;
  } catch {
    return false;
  }
}

/* ── Verbose LLM sink (bypasses logger.ts IS_DEV gate) ────────────── *
 * When the user opts in via `diamond_verbose_llm=true`, the body of the
 * LLM reply MUST reach a sink they can review — even on a production
 * CRX where the `logger.debug` IS_DEV gate would otherwise silence it.
 * Two destinations:
 *   (a) SW DevTools console — `console.log` is never IS_DEV-gated.
 *   (b) Persistent chrome.storage.local buffer — Options page reads,
 *       formats, and offers copy/download so the user can review past
 *       LLM responses across reloads.
 * Failures are silent; a logging write must never break a real reply.
 * ────────────────────────────────────────────────────────────────── */
const VERBOSE_BUFFER_KEY = 'diamond_verbose_log_buffer';
const VERBOSE_BUFFER_MAX = 50;
const VERBOSE_PROMPT_TRUNCATE = 400;
const VERBOSE_RAW_TRUNCATE = 8000;

async function captureVerboseLLMBody(
  raw: string,
  systemPrompt: string,
  userMessage: string,
  attempt: number,
): Promise<void> {
  // (a) SW DevTools console — single multi-line marker
  // eslint-disable-next-line no-console
  console.log(
    '[Diamond VERBOSE LLM] attempt=' + attempt +
      '\nsystem: ' + String(systemPrompt || '').slice(0, VERBOSE_PROMPT_TRUNCATE) +
      '\nuser: '   + String(userMessage  || '').slice(0, VERBOSE_PROMPT_TRUNCATE) +
      '\nraw: '    + String(raw         || ''),
  );

  // (b) Persistent storage — capped at 50 entries, oldest evicted first.
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    const stored = await chrome.storage.local.get(VERBOSE_BUFFER_KEY);
    const buf: Array<Record<string, unknown>> = Array.isArray(
      stored[VERBOSE_BUFFER_KEY],
    )
      ? (stored[VERBOSE_BUFFER_KEY] as Array<Record<string, unknown>>)
      : [];
    buf.push({
      ts: Date.now(),
      attempt,
      systemPrompt: String(systemPrompt || '').slice(0, VERBOSE_RAW_TRUNCATE),
      userMessage:  String(userMessage  || '').slice(0, VERBOSE_PROMPT_TRUNCATE),
      raw:          String(raw         || '').slice(0, VERBOSE_RAW_TRUNCATE),
    });
    while (buf.length > VERBOSE_BUFFER_MAX) buf.shift();
    await chrome.storage.local.set({ [VERBOSE_BUFFER_KEY]: buf });
  } catch {
    /* silent — never let logging break a real LLM reply */
  }
}

// ---------------------------------------------------------------------------
// Response validation (strict-mode safe)
// ---------------------------------------------------------------------------

/**
 * Attempt to extract `choices[0].message.content` as a string from an
 * unknown-shaped Fireworks API response. Returns null on any shape mismatch.
 */
function extractContent(data: unknown): string | null {
  if (data === null || typeof data !== 'object') return null;

  const root = data as Record<string, unknown>;
  if (!Array.isArray(root.choices)) return null;

  const choice = root.choices[0];
  if (choice === null || typeof choice !== 'object') return null;

  const choiceObj = choice as Record<string, unknown>;
  if (choiceObj.message === null || typeof choiceObj.message !== 'object')
    return null;

  const content = (choiceObj.message as Record<string, unknown>).content;
  return typeof content === 'string' ? content : null;
}

// ---------------------------------------------------------------------------
// Core — pure function, no chrome.* references
// ---------------------------------------------------------------------------

/**
 * Call Fireworks chat completions API with explicit parameters.
 * Pure function — injectable fetchImpl enables unit testing without network.
 *
 * @param systemPrompt - System-level instruction for the model
 * @param userMessage  - User message / current command
 * @param apiKey       - Fireworks API key (bearer token)
 * @param model        - Model ID to use (e.g. DEV_MODEL_ID)
 * @param fetchImpl    - fetch implementation (inject mock in tests, real in SW)
 * @returns The model's response text
 * @throws Error with user-facing message on HTTP/parse failures
 */
export async function callLLMCore(
  systemPrompt: string,
  userMessage: string,
  apiKey: string,
  model: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(FIREWORKS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Fireworks API error ${response.status}: ${body}`);
  }

  const data: unknown = await response.json();
  const content = extractContent(data);

  if (content === null) {
    throw new Error('Malformed Fireworks response');
  }

  return content;
}

// ---------------------------------------------------------------------------
// Wrapper — reads key + model from chrome.storage.local
// ---------------------------------------------------------------------------

/**
 * Call Fireworks chat completions, reading API key and model override from
 * chrome.storage.local. Intended for the service worker — NOT unit-tested
 * (touches chrome.*).
 *
 * Model resolution order:
 *   1. Explicit `model` parameter
 *   2. `chrome.storage.local.get('diamond_model')` (production swap key)
 *   3. Hard default → DEV_MODEL_ID (MiniMax M3)
 *
 * @param systemPrompt - System-level instruction
 * @param userMessage  - User message / command
 * @param model        - Optional model override
 * @returns The model's response text
 * @throws Error("API key not configured. Open extension settings.") if missing
 */
export async function callLLM(
  systemPrompt: string,
  userMessage: string,
  model?: string,
): Promise<string> {
  const result = await chrome.storage.local.get([
    'diamond_api_key',
    'diamond_model',
  ]);

  const apiKey = result.diamond_api_key as string | undefined;
  if (!apiKey) {
    throw new Error('API key not configured. Open extension settings.');
  }

  const selectedModel =
    model ?? (result.diamond_model as string | undefined) ?? DEV_MODEL_ID;

  return callLLMCore(
    systemPrompt,
    userMessage,
    apiKey,
    selectedModel,
    globalThis.fetch,
  );
}

// ---------------------------------------------------------------------------
// Retry + JSON re-prompt wrapper
// ---------------------------------------------------------------------------

/**
 * Call Fireworks with retry and JSON response validation.
 *
 * Strategy:
 *   1. Attempt → callLLM → tryParseJSON
 *   2. If JSON parse fails AND retries remain: re-prompt describing the error
 *   3. If callLLM throws (network/HTTP): wait 1000ms, retry once
 *   4. After exhaustion: throw Error("Fireworks API call failed")
 *
 * No model fallback. If MiniMax M3 is down, Diamond says unavailable.
 *
 * @param systemPrompt - System-level instruction
 * @param userMessage  - User message / command
 * @param retries      - Number of retries (default 1, so up to 2 total attempts)
 * @returns Validated JSON string or raw text on last attempt
 */
export async function callLLMWithRetry(
  systemPrompt: string,
  userMessage: string,
  retries = 1,
): Promise<string> {
  // B1 — verbose mode dumps the actual Fireworks response body for PC QA
  // diagnostics. We read the flag once at entry (the user won't toggle it
  // in the middle of a single command's round-trip; if they do, the next
  // command picks up the new value). logger.debug is auto-no-op in
  // production (Phase L: IS_DEV gate) so the storage read + emission
  // happen ONLY in dev builds; production CRX has neither cost nor output.
  const verboseLlm = await isVerboseLlmOn();

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const raw = await callLLM(systemPrompt, userMessage);
      if (verboseLlm) {
        // The user opted in via `diamond_verbose_llm=true`. The body MUST
        // reach a sink they can review — even on a production CRX where
        // logger.debug's IS_DEV gate would silence the existing emission.
        // Two destinations: SW DevTools console + persistent storage buffer.
        await captureVerboseLLMBody(raw, systemPrompt, userMessage, attempt);
      }
      const parsed = tryParseJSON(raw);

      if (parsed) {
        // Valid JSON — return as stringified JSON for structured consumption
        return JSON.stringify(parsed);
      }

      // Not valid JSON — re-prompt if retries remain
      if (attempt < retries) {
        userMessage = `${raw} — this is not valid JSON. Please respond with only a JSON object matching the schema.`;
        continue;
      }

      // Last attempt — return raw text as-is (spoken fallback)
      return raw;
    } catch {
      if (attempt === retries) {
        throw new Error('Fireworks API call failed');
      }

      // Wait 1 second before retrying on HTTP/network failure
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // TypeScript exhaustiveness guard — should never reach here
  throw new Error('Fireworks API call failed');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to parse a string as JSON. Returns the parsed object on success,
 * null on failure. Only attempts parse if the trimmed input starts with '{'.
 *
 * @param text - Raw response text
 * @returns Parsed object, or null if parsing fails
 */
export function tryParseJSON(text: string): object | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;

  try {
    return JSON.parse(trimmed) as object;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// VLM — multimodal (vision) call
// ---------------------------------------------------------------------------

/**
 * Call Fireworks with a multimodal (text + image) message.
 *
 * Uses the same API key and model resolution as callLLM().
 * MiniMax M3 supports this format natively.
 *
 * @param systemPrompt - System-level instruction
 * @param imageBase64  - PNG screenshot encoded as base64 (without data: URL prefix)
 * @param userMessage  - Optional user message (default: "Describe this webpage")
 * @returns The model's response text
 * @throws Error('API key not configured.') if key is missing
 * @throws Error('Fireworks API error ...') on HTTP failure
 */
export async function callVLM(
  systemPrompt: string,
  imageBase64: string,
  userMessage?: string,
): Promise<string> {
  const result = await chrome.storage.local.get([
    'diamond_api_key',
    'diamond_model',
  ]);

  const apiKey = result.diamond_api_key as string | undefined;
  if (!apiKey) {
    throw new Error('API key not configured. Open extension settings.');
  }

  const model =
    (result.diamond_model as string | undefined) ?? DEV_MODEL_ID;

  const userContent: Array<Record<string, unknown>> = [
    {
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${imageBase64}` },
    },
  ];
  if (userMessage) {
    userContent.push({ type: 'text', text: userMessage });
  }

  const response = await globalThis.fetch(FIREWORKS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Fireworks API error ${response.status}: ${body}`);
  }

  const data: unknown = await response.json();
  const content = extractContent(data);
  if (content === null) {
    throw new Error('Malformed Fireworks response');
  }
  return content;
}
