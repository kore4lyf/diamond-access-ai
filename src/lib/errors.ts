/**
 * Diamond Access AI — Central Error UX Constants
 *
 * Phase H: Every spoken error message lives here so the PM can review
 * and tune them without reading action/voice code.
 *
 * Rule (non-negotiable):
 *   Every speak() call that delivers an error uses these constants.
 *   No hardcoded error strings in voice.ts, actions.ts, background.ts,
 *   or content.ts.
 */

// ---------------------------------------------------------------------------
// Error constants
// ---------------------------------------------------------------------------

export const ERRORS = {
  // ── STT / voice ──────────────────────────────────────────────────────

  /** Microphone permission denied — user must grant it. */
  MIC_BLOCKED:
    'Microphone access is blocked. Please allow mic permissions.',

  /** Network issue during speech recognition. */
  STT_NETWORK: "I can't hear you right now — check your connection.",

  /** User released Alt+D with nothing recognized — intentional silence. */
  STT_NO_SPEECH: '',

  /** Catch-all for other STT errors. */
  STT_OTHER: "I didn't catch that. Try again.",

  /** TTS output unavailable — fallback to on-screen text. */
  TTS_UNAVAILABLE: 'TTS not available.',

  // ── AI / network ─────────────────────────────────────────────────────

  /** AI service (Fireworks API) is down or unreachable. */
  AI_UNAVAILABLE: 'AI service unavailable. Please try again.',

  /** Fireworks API key not configured in settings. */
  API_KEY_MISSING:
    'Diamond is not configured yet. Open extension settings to set your API key.',

  /** Service worker terminated mid-command. */
  SW_TERMINATED: 'I lost my connection. Try again.',

  /** LLM returned empty or falsy response. */
  EMPTY_RESPONSE: "I didn't get a response. Try again.",

  /** LLM returned unparseable JSON. */
  INVALID_JSON:
    'The AI returned an unexpected response. Let me try again.',

  // ── Action execution ─────────────────────────────────────────────────

  /** Element index out of bounds or DOM changed. */
  ELEMENT_NOT_FOUND:
    "I couldn't find that element on the page. The page may have changed.",

  /** Generic fill failure (read-only / disabled / unknown). */
  FILL_FAILED: "I couldn't fill that field. It may be read-only or disabled.",

  /** Navigation blocked or failed. */
  NAV_FAILED: "I couldn't navigate to that page. It may be blocked.",

  /** javascript: URLs are refused for security. */
  JS_REFUSED: "I can't navigate to that type of URL.",

  /** Action execution threw an unexpected error. */
  SOMETHING_WRONG:
    'Something went wrong executing that action. Try again.',

  // ── Sensitive field confirmations ────────────────────────────────────

  /** Generic sensitive field confirmation. */
  SENSITIVE_CONFIRM: (field: string) =>
    `Filling your ${field}. Say 'confirm' to proceed.`,

  /** Credit card mask — only last 4 digits are spoken. */
  SENSITIVE_CC_CONFIRM: (last4: string) =>
    `Filling card ending in ${last4}. Say 'confirm' to proceed.`,

  /** SSN mask — only last 4 digits are spoken. */
  SENSITIVE_SSN_CONFIRM: (last4: string) =>
    `Filling SSN ending in ${last4}. Say 'confirm' to proceed.`,

  // ── Confirmation flow ────────────────────────────────────────────────

  /** Prompt user to confirm an action (e.g., "This will submit your order..."). */
  CONFIRM_PROMPT: (action: string) =>
    `This will ${action}. Say 'confirm' to proceed.`,

  /** User cancelled or said something other than yes/confirm. */
  ACTION_CANCELLED: 'Action cancelled.',

  // ── Link selection (Phase K) ─────────────────────────────────────────

  /**
   * LLM returned malformed/unknown response for link_select.
   */
  LINK_SELECT_FAILED: "I couldn't match that link. Try rephrasing.",

  /**
   * No matching link was found for the user's description.
   */
  LINK_NOT_FOUND: "I couldn't find that link on the page.",

  // ── Context / session ────────────────────────────────────────────────

  /** Session was successfully cleared. */
  CLEAR_CONTEXT: 'Context cleared.',

  /** "Where was I?" — recaps the active goal and last turns. */
  WHERE_WAS_I: (goal: string, turns: string) =>
    `Your goal was: ${goal}. ${turns}`,

  /** No context available for recap. */
  NO_CONTEXT: "I don't have any recent context.",

  // ── Activation mode toggle (Phase J) ─────────────────────────────────

  /**
   * Spoken feedback when the user enables hands-free mode.
   * Kept terse — blind users hear this repeatedly. The persona's voice rules
   * say "OK. is fine, Certainly! is not" and "be brief." Letting the model
   * elaborate longer explanations would slow hands-free mode down between
   * utterances, which defeats the purpose. Helper context (longer text,
   * settings shortcut, status pulse) lives in the popup UI, not in TTS.
   */
  MODE_HANDS_FREE_ON: 'Hands-free mode.',

  /** Spoken feedback when the user reverts to command (push-to-talk) mode. */
  MODE_COMMAND_ON: 'Command mode.',

  /** Mode switch attempt failed (storage error / race / missing permission). */
  MODE_SWITCH_FAILED:
    "I couldn't switch modes. Try opening the extension popup to toggle it manually.",
} as const;

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

/** Inferred type for IDE autocompletion and strict-checking. */
export type ErrorConstants = typeof ERRORS;
