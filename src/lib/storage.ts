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
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max conversation turns (1 user + 1 assistant = 1 turn). FIFO when exceeded. */
export const MAX_TURNS = 10;

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
      return 'Context cleared.';
    }
  }
  return null;
}

/**
 * Check if the transcript is a "where was I?" query.
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
      const parts: string[] = [];
      if (session.activeGoal) {
        parts.push(`Your active goal is: ${session.activeGoal}.`);
      }
      const recentTurns = session.conversation.slice(-2);
      if (recentTurns.length > 0) {
        parts.push('Here is what we were doing:');
        for (const turn of recentTurns) {
          parts.push(`You said: "${turn.user}". I replied: "${turn.assistant}".`);
        }
      }
      if (parts.length === 0) {
        return "We haven't done anything yet. What can I help you with?";
      }
      return parts.join(' ');
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
      return normalized.endsWith('.') ? normalized : normalized + '.';
    }
  }
  return null;
}
