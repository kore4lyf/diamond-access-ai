/**
 * Diamond Access AI — Storage Engine
 *
 * Phase G: Gives Diamond memory. Two storage scopes:
 *   Session — conversation history (max 10 turns), active goal, form state
 *   Profile — saved addresses, links, preferences (persisted across restarts)
 *
 * Architecture (per DOC-CONTEXT-MEMORY §2):
 *   createStorage(fakeStore) — chrome-free core, jsdom-testable
 *   storage — production wrapper injecting chrome.storage.local
 *
 * Privacy (DOC-CONTEXT-MEMORY §6, non-negotiable):
 *   - Profile values (addresses, phone, email) are NEVER sent to the LLM.
 *     Only labels ("Home", "Office", "email address") flow into the prompt.
 *   - formState holds PII the user never spoke — it is NEVER read by
 *     the prompt builder.
 *
 * Phase H invariant (applied):
 *   Every spoken user-facing string lives in `errors.ts` `ERRORS.*`.
 *   No hardcoded strings in this module.
 */

import { ERRORS } from './errors';
import * as logger from './logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max conversation turns (1 user + 1 assistant = 1 turn). FIFO when exceeded. */
export const MAX_TURNS = 10;

/**
 * Activation mode — determines how Diamond's listening session behaves.
 *
 * - 'command': push-to-talk. Each Alt+D / icon click starts ONE recognition
 *   session; release ends it. Default.
 * - 'hands_free': one activation + auto-rearm between utterances. Recognition
 *   stays open so multiple commands can flow without re-pressing. Sleeps
 *   after 60s of inactivity (the same sleep timeout as command mode).
 */
export type DiamondMode = 'command' | 'hands_free';
export const DEFAULT_MODE: DiamondMode = 'command';
const VALID_MODES: readonly DiamondMode[] = ['command', 'hands_free'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Turn {
  user: string;
  assistant: string;
}

export interface SessionState {
  /** Max 10 turns, FIFO — oldest dropped when full. */
  conversation: Turn[];
  /** Current active goal (e.g., "buying a blue shirt under $40"). Null if none. */
  activeGoal: string | null;
  /**
   * Form field values the user entered (PII — NEVER sent to the LLM).
   * Key = field label / purpose, value = actual text.
   */
  formState: Record<string, string>;
}

export interface SavedAddress {
  label: string;
  lines: string[];
}

export interface SavedLink {
  label: string;
  url: string;
}

export interface UserProfile {
  savedAddresses: SavedAddress[];
  savedLinks: SavedLink[];
  preferences: {
    currency: string;
    language: string;
  };
  /** Contact info — stored locally, only labels sent to LLM. */
  email: string;
  phone: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export function emptySession(): SessionState {
  return {
    conversation: [],
    activeGoal: null,
    formState: {},
  };
}

export function defaultProfile(): UserProfile {
  return {
    savedAddresses: [],
    savedLinks: [],
    preferences: {
      currency: 'USD',
      language: 'en',
    },
    email: '',
    phone: '',
  };
}

/**
 * Validate a stored mode value. Returns the mode if it's a known value,
 * otherwise returns DEFAULT_MODE. Defensive — storage is untrusted input
 * (chrome.storage.local can be edited by the user from devtools).
 */
export function normalizeMode(raw: unknown): DiamondMode {
  if (typeof raw === 'string' && (VALID_MODES as readonly string[]).includes(raw)) {
    return raw as DiamondMode;
  }
  return DEFAULT_MODE;
}

// ---------------------------------------------------------------------------
// Mode-switch voice intent detection (Phase J)
// ---------------------------------------------------------------------------

/** Phrases that flip activation mode to hands-free. */
const HF_SWITCH_PATTERNS: readonly RegExp[] = [
  /\b(?:switch|go|enable|turn\s+on)?\s*(?:to\s+)?hands[\s-]?free(?:\s+mode)?\b/i,
  /\bhands[\s-]?free\s+please\b/i,
];

/** Phrases that flip activation mode back to command (push-to-talk). */
const CMD_SWITCH_PATTERNS: readonly RegExp[] = [
  /\b(?:switch|go(?: back)?|enable|turn\s+on)?\s*(?:to\s+)?command(?:\s+mode)?\b/i,
  /\bback\s+to\s+normal\b/i,
];

/**
 * Detect a voice request to switch activation mode. Returns the target
 * mode if matched, null otherwise. Conservative — prefers hands-free
 * match first because going from command → hands-free is the default
 * "I want to stop pressing Alt+D" ask.
 */
export function detectModeSwitch(transcript: string): DiamondMode | null {
  const trimmed = String(transcript ?? '').trim();
  if (!trimmed) return null;
  for (const pattern of HF_SWITCH_PATTERNS) {
    if (pattern.test(trimmed)) return 'hands_free';
  }
  for (const pattern of CMD_SWITCH_PATTERNS) {
    if (pattern.test(trimmed)) return 'command';
  }
  return null;
}

/**
 * Compute the opposite activation mode. Pure helper for the Alt+S toggle
 * (and any future "flip the mode" code path): no IO, no state, and
 * involutive — `nextMode(nextMode(x)) === x`.
 */
export function nextMode(current: DiamondMode): DiamondMode {
  return current === 'hands_free' ? 'command' : 'hands_free';
}

// ---------------------------------------------------------------------------
// Storage backend interface
// ---------------------------------------------------------------------------

export interface StorageBackend {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const SESSION_KEY = 'diamond_session';
const PROFILE_KEY = 'diamond_profile';
const MODE_KEY = 'diamond_mode';

// ---------------------------------------------------------------------------
// Chrome-free core factory
// ---------------------------------------------------------------------------

/**
 * Create a storage instance backed by an arbitrary store.
 * Pure — no chrome.* references, jsdom-testable with a fake store.
 *
 * @param store - Storage backend with get/set/remove
 * @returns Object with getSession, setSession, appendTurn, clearSession,
 *          getProfile, setProfile
 */
export function createStorage(store: StorageBackend) {
  return {
    // ── Session ──────────────────────────────────────────────────────────

    /** Load the current session (or default if none stored). */
    async getSession(): Promise<SessionState> {
      const result = await store.get([SESSION_KEY]);
      const raw = result[SESSION_KEY] as SessionState | undefined;
      return raw ?? emptySession();
    },

    /** Overwrite the entire session state. */
    async setSession(s: SessionState): Promise<void> {
      await store.set({ [SESSION_KEY]: s });
    },

    /**
     * Append a conversation turn, cap at MAX_TURNS (FIFO), save, return new state.
     *
     * @param turn - The turn to append
     * @returns The updated session state
     */
    async appendTurn(turn: Turn): Promise<SessionState> {
      const session = await this.getSession();
      session.conversation.push(turn);
      // FIFO: keep only the last MAX_TURNS
      if (session.conversation.length > MAX_TURNS) {
        session.conversation = session.conversation.slice(-MAX_TURNS);
      }
      await store.set({ [SESSION_KEY]: session });
      return session;
    },

    /** Clear session (conversation, goal, form state). Profile untouched. */
    async clearSession(): Promise<void> {
      await store.remove([SESSION_KEY]);
    },

    // ── Profile ──────────────────────────────────────────────────────────

    /** Load the user profile (or default if none stored). */
    async getProfile(): Promise<UserProfile> {
      const result = await store.get([PROFILE_KEY]);
      const raw = result[PROFILE_KEY] as UserProfile | undefined;
      return raw ?? defaultProfile();
    },

    /** Overwrite the entire user profile. */
    async setProfile(p: UserProfile): Promise<void> {
      await store.set({ [PROFILE_KEY]: p });
    },

    // ── Mode (activation style) ──────────────────────────────────────────

    /** Load the current activation mode. Falls back to DEFAULT_MODE. */
    async getMode(): Promise<DiamondMode> {
      const result = await store.get([MODE_KEY]);
      return normalizeMode(result[MODE_KEY]);
    },

    /** Persist the activation mode. Invalid values are coerced to default. */
    async setMode(mode: DiamondMode): Promise<void> {
      const safe = normalizeMode(mode);
      await store.set({ [MODE_KEY]: safe });
    },
  };
}

// ---------------------------------------------------------------------------
// Production wrapper
// ---------------------------------------------------------------------------

/**
 * Production storage instance backed by chrome.storage.local.
 * Undefined-safe — if chrome.* is not available (test environment),
 * operations resolve to defaults.
 */
export const storage = createStorage({
  get: (keys) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      return chrome.storage.local.get(keys);
    }
    return Promise.resolve({});
  },
  set: (items) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      return chrome.storage.local.set(items);
    }
    return Promise.resolve();
  },
  remove: (keys) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      return chrome.storage.local.remove(keys);
    }
    return Promise.resolve();
  },
});

// ---------------------------------------------------------------------------
// Goal detection (heuristic — no LLM call)
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate the user is setting a new goal.
 * If matched, `activeGoal` is set to the normalized transcript.
 */
const GOAL_PATTERNS = [
  /^(find|search|look)\s+(for|up|a|me)?\s+/i,
  /^i\s+(want|need|would\s+like|am\s+looking)\s+(to|for)\s+/i,
  /^(buy|order|purchase|get)\s+/i,
  /^(apply|sign)\s+(for|up)\s+/i,
  /^compare\s+/i,
];

/**
 * Phrases that should clear the session context.
 */
const CLEAR_PATTERNS = [
  /^clear\s+(context|history|session|memory|everything)/i,
  /^forget\s+(what\s+we\s+were\s+doing|this\s+conversation|everything)/i,
  /^(reset|restart|start\s+over)/i,
];

/**
 * Phrases that ask where we were.
 */
const WHERE_WAS_I_PATTERNS = [
  /^where\s+(was\s+I|were\s+we)/i,
  /^what\s+(was\s+I\s+doing|were\s+we\s+doing)/i,
  /^(recap|remind\s+me|what\'?s?\s+going\s+on)/i,
];

/**
 * Check if the transcript is a "clear context" command and handle it.
 *
 * Uses `ERRORS.CLEAR_CONTEXT` for the spoken confirmation (Phase H invariant).
 *
 * @param transcript - The user's spoken command
 * @param storeInstance - The storage instance (for clearSession)
 * @returns A response string if it was a clear command, null otherwise
 */
export async function handleClearCommand(
  transcript: string,
  storeInstance: ReturnType<typeof createStorage>,
): Promise<string | null> {
  for (const pattern of CLEAR_PATTERNS) {
    if (pattern.test(transcript.trim())) {
      await storeInstance.clearSession();
      return ERRORS.CLEAR_CONTEXT;
    }
  }
  return null;
}

/**
 * Check if the transcript is a "where was I?" query.
 *
 * Uses `ERRORS.*` constants for every spoken string (Phase H invariant).
 *
 * @param transcript - The user's spoken command
 * @param session - Current session state
 * @returns A response string if it was a where-was-I query, null otherwise
 */
export function handleWhereWasI(
  transcript: string,
  session: SessionState,
): string | null {
  for (const pattern of WHERE_WAS_I_PATTERNS) {
    if (pattern.test(transcript.trim())) {
      const recentTurns = session.conversation.slice(-2);
      const hasGoal = !!session.activeGoal;
      const hasTurns = recentTurns.length > 0;

      // No goal AND no recent turns — bare session.
      if (!hasGoal && !hasTurns) {
        return ERRORS.NO_CONTEXT;
      }

      // Strip trailing punctuation from goal so WHERE_WAS_I's "."
      // doesn't produce a double period.
      const normalizedGoal = (session.activeGoal ?? '').replace(/\.+$/, '');
      const turnsText = recentTurns
        .map((t) => `You said "${t.user}". I said "${t.assistant}".`)
        .join(' ');

      return ERRORS.WHERE_WAS_I(normalizedGoal, turnsText);
    }
  }
  return null;
}

/**
 * Detect if the transcript sets a new active goal.
 *
 * @param transcript - The user's spoken command
 * @returns A normalized goal string if detected, null otherwise
 */
export function detectGoal(transcript: string): string | null {
  const trimmed = transcript.trim();
  for (const pattern of GOAL_PATTERNS) {
    if (pattern.test(trimmed)) {
      // Normalize to ~10 words
      const words = trimmed.split(/\s+/);
      const normalized = words.slice(0, 12).join(' ');
      const result = normalized.endsWith('.') ? normalized : normalized + '.';
      logger.debug('storage', 'goal detected', {
        preview: result.slice(0, 60),
      });
      return result;
    }
  }
  return null;
}
