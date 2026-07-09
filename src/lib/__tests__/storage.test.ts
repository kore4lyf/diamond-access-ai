/**
 * Diamond Access AI — Storage Engine Tests
 *
 * Phase G: Unit tests for createStorage, session management, profile,
 * goal detection, buildCommandPrompt, and the PII-never-to-LLM guard.
 *
 * All tests run under vitest + jsdom — no chrome, no network.
 * The chrome-free core is tested with a fake store.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DiamondAction } from '../actions';
import {
  createStorage,
  MAX_TURNS,
  emptySession,
  defaultProfile,
  detectGoal,
  handleClearCommand,
  handleWhereWasI,
  type SessionState,
  type Turn,
  type StorageBackend,
} from '../storage';
import { buildCommandPrompt } from '../prompts';
import { ERRORS } from '../errors';

// ---------------------------------------------------------------------------
// Fake store
// ---------------------------------------------------------------------------

/**
 * An in-memory store that mimics chrome.storage.local for testing.
 */
function fakeStore(): {
  store: StorageBackend;
  data: Record<string, unknown>;
} {
  const data: Record<string, unknown> = {};
  return {
    store: {
      get: async (keys: string[]) => {
        const result: Record<string, unknown> = {};
        for (const key of keys) {
          if (key in data) result[key] = data[key];
        }
        return result;
      },
      set: async (items: Record<string, unknown>) => {
        Object.assign(data, items);
      },
      remove: async (keys: string[]) => {
        for (const key of keys) {
          delete data[key];
        }
      },
    },
    data,
  };
}

// ---------------------------------------------------------------------------
// Smoke
// ---------------------------------------------------------------------------

describe('smoke', () => {
  it('1 + 1 === 2', () => {
    expect(1 + 1).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// createStorage — core operations
// ---------------------------------------------------------------------------

describe('createStorage core', () => {
  it('getSession returns empty session when nothing stored', async () => {
    const { store } = fakeStore();
    const s = createStorage(store);
    const session = await s.getSession();

    expect(session.conversation).toEqual([]);
    expect(session.activeGoal).toBeNull();
    expect(session.formState).toEqual({});
  });

  it('setSession round-trips correctly', async () => {
    const { store } = fakeStore();
    const s = createStorage(store);

    const expected: SessionState = {
      conversation: [{ user: 'hi', assistant: 'hello' }],
      activeGoal: 'buying a shirt',
      formState: { email: 'test@test.com' },
    };

    await s.setSession(expected);
    const loaded = await s.getSession();

    expect(loaded).toEqual(expected);
  });

  it('appendTurn adds a turn and returns updated session', async () => {
    const { store } = fakeStore();
    const s = createStorage(store);

    const turn: Turn = { user: 'hello', assistant: 'Hi there!' };
    const updated = await s.appendTurn(turn);

    expect(updated.conversation).toHaveLength(1);
    expect(updated.conversation[0]).toEqual(turn);
  });

  it('appendTurn keeps the turn in storage', async () => {
    const { store } = fakeStore();
    const s = createStorage(store);

    await s.appendTurn({ user: 'test', assistant: 'response' });
    const loaded = await s.getSession();
    expect(loaded.conversation).toHaveLength(1);
  });

  it('appendTurn caps at MAX_TURNS (FIFO)', async () => {
    const { store } = fakeStore();
    const s = createStorage(store);

    // Push 12 turns (MAX_TURNS is 10)
    for (let i = 0; i < 12; i++) {
      await s.appendTurn({ user: `user${i}`, assistant: `resp${i}` });
    }

    const session = await s.getSession();
    expect(session.conversation).toHaveLength(MAX_TURNS);

    // The oldest 2 should be dropped — first should be user2
    expect(session.conversation[0].user).toBe('user2');
    expect(session.conversation[MAX_TURNS - 1].user).toBe('user11');
  });

  it('clearSession removes session but preserves profile', async () => {
    const { store, data } = fakeStore();
    const s = createStorage(store);

    await s.setSession({
      conversation: [{ user: 'hi', assistant: 'hello' }],
      activeGoal: 'test',
      formState: {},
    });
    await s.setProfile(defaultProfile());

    expect(data['diamond_session']).toBeDefined();
    expect(data['diamond_profile']).toBeDefined();

    await s.clearSession();

    expect(data['diamond_session']).toBeUndefined();
    expect(data['diamond_profile']).toBeDefined();
  });

  it('getProfile returns default when nothing stored', async () => {
    const { store } = fakeStore();
    const s = createStorage(store);
    const profile = await s.getProfile();

    expect(profile.savedAddresses).toEqual([]);
    expect(profile.savedLinks).toEqual([]);
    expect(profile.email).toBe('');
    expect(profile.phone).toBe('');
    expect(profile.preferences.currency).toBe('USD');
  });

  it('setProfile round-trips correctly', async () => {
    const { store } = fakeStore();
    const s = createStorage(store);

    const profile = {
      savedAddresses: [{ label: 'Home', lines: ['123 Main St', 'Apt 4B'] }],
      savedLinks: [{ label: 'GitHub', url: 'https://github.com/kore4lyf' }],
      preferences: { currency: 'NGN', language: 'en' },
      email: 'test@example.com',
      phone: '+234800000000',
    };

    await s.setProfile(profile);
    const loaded = await s.getProfile();

    expect(loaded).toEqual(profile);
  });
});

// ---------------------------------------------------------------------------
// buildCommandPrompt — context layering
// ---------------------------------------------------------------------------

describe('buildCommandPrompt', () => {
  it('builds prompt with COMMAND_TASK content + page + command (no context)', () => {
    const session = emptySession();
    const prompt = buildCommandPrompt({
      pageStructure: '[button] "Click me"',
      transcript: 'click the button',
      session,
    });

    // The user-message portion contains COMMAND_TASK content (schemas,
    // worked examples, INPUT block) — persona is sent separately as system
    // and is therefore NOT in the user message. Test the COMMAND_TASK
    // signature content instead.
    expect(prompt).toContain('ACTION SCHEMAS');
    expect(prompt).toContain('[button] "Click me"');
    expect(prompt).toContain('click the button');
    // The optional ACTIVE GOAL input-block section is stripped when goal
    // is empty — the label header itself must not appear.
    expect(prompt).not.toContain('ACTIVE GOAL:');
    // The optional CONVERSATION HISTORY input-block section is stripped
    // when history is empty — the input-block label header goes away.
    // (Note: the phrase "CONVERSATION HISTORY" still legitimately appears
    // earlier in COMMAND_TASK's FORMAT RULES, so test the specific header.)
    expect(prompt).not.toContain('CONVERSATION HISTORY (most recent last):');
    // And no placeholder / substitution text survives in the empty case.
    expect(prompt).not.toContain('(none set)');
    expect(prompt).not.toContain('(no prior turns)');
  });

  it('includes active goal when set', () => {
    const session: SessionState = {
      conversation: [],
      activeGoal: 'buying a blue shirt under $40.',
      formState: {},
    };
    const prompt = buildCommandPrompt({
      pageStructure: 'text',
      transcript: 'show me',
      session,
    });

    expect(prompt).toContain('ACTIVE GOAL:');
    expect(prompt).toContain('buying a blue shirt under $40.');
  });

  it('includes conversation history when present', () => {
    const session: SessionState = {
      conversation: [
        { user: 'find a shirt', assistant: 'Found 3 shirts.' },
      ],
      activeGoal: null,
      formState: {},
    };
    const prompt = buildCommandPrompt({
      pageStructure: 'text',
      transcript: 'show the cheapest',
      session,
    });

    expect(prompt).toContain('CONVERSATION HISTORY (most recent last):');
    expect(prompt).toContain('"find a shirt"');
    expect(prompt).toContain('"Found 3 shirts."');
  });

  it('trims history to last 10 turns in prompt', () => {
    const conversation: Turn[] = [];
    for (let i = 0; i < 15; i++) {
      conversation.push({ user: `user${i}`, assistant: `resp${i}` });
    }
    const session: SessionState = {
      conversation,
      activeGoal: null,
      formState: {},
    };
    const prompt = buildCommandPrompt({
      pageStructure: 'text',
      transcript: 'check',
      session,
    });

    // Should contain user5 (5th from end of 15 = index 5)
    expect(prompt).toContain('"user5"');
    // Should contain user14 (the latest)
    expect(prompt).toContain('"user14"');
    // Should NOT contain user0 (dropped)
    expect(prompt).not.toContain('"user0"');
    expect(prompt).not.toContain('"user1"');
    expect(prompt).not.toContain('"user2"');
    expect(prompt).not.toContain('"user3"');
    expect(prompt).not.toContain('"user4"');
  });

  it('includes URL when provided', () => {
    const session = emptySession();
    const prompt = buildCommandPrompt({
      pageStructure: 'text',
      transcript: 'hi',
      session,
      url: 'https://example.com/shop',
    });

    expect(prompt).toContain('https://example.com/shop');
  });

  it('falls back to (unknown url) when no URL provided', () => {
    const session = emptySession();
    const prompt = buildCommandPrompt({
      pageStructure: 'text',
      transcript: 'hi',
      session,
    });
    expect(prompt).toContain('URL: (unknown url)');
  });

  // ── PRIVACY TEST (HARD) ──────────────────────────────────────────────

  it('PRIVACY: formState PII never leaks into prompt', () => {
    // Fill formState with real PII
    const session: SessionState = {
      conversation: [],
      activeGoal: null,
      formState: {
        email: 'john.doe@example.com',
        phone: '+1-555-123-4567',
        ssn: '123-45-6789',
        address: '123 Main St, New York, NY 10001',
      },
    };
    const prompt = buildCommandPrompt({
      pageStructure: 'text',
      transcript: 'check status',
      session,
    });

    // None of the PII values should appear in the prompt
    expect(prompt).not.toContain('john.doe@example.com');
    expect(prompt).not.toContain('+1-555-123-4567');
    expect(prompt).not.toContain('123-45-6789');
    expect(prompt).not.toContain('123 Main St');

    // The prompt should still work — transcript is there
    expect(prompt).toContain('check status');
  });
});

// ---------------------------------------------------------------------------
// Goal detection
// ---------------------------------------------------------------------------

describe('detectGoal', () => {
  it('detects "find a ..." pattern', () => {
    const goal = detectGoal('find a blue shirt under $40');
    expect(goal).toBeTruthy();
    expect(goal).toContain('find a blue shirt under $40');
  });

  it('detects "search for ..." pattern', () => {
    const goal = detectGoal('search for cheap laptops');
    expect(goal).toBeTruthy();
  });

  it('detects "I want to ..." pattern', () => {
    const goal = detectGoal('I want to apply for a job');
    expect(goal).toBeTruthy();
    expect(goal).toContain('apply for a job');
  });

  it('detects "buy ..." pattern', () => {
    const goal = detectGoal('buy a pair of sneakers');
    expect(goal).toBeTruthy();
  });

  it('detects "compare ..." pattern', () => {
    const goal = detectGoal('compare prices on AirPods');
    expect(goal).toBeTruthy();
  });

  it('returns null for non-goal phrases', () => {
    expect(detectGoal('go back')).toBeNull();
    expect(detectGoal('scroll down')).toBeNull();
    expect(detectGoal('what is this page')).toBeNull();
    expect(detectGoal('click the button')).toBeNull();
  });

  it('normalizes goal to ~12 words', () => {
    const long = 'find a really really really really really really really long sentence that goes on and on and on';
    const goal = detectGoal(long);
    expect(goal).toBeTruthy();
    const words = (goal ?? '').split(/\s+/);
    expect(words.length).toBeLessThanOrEqual(13);
  });
});

// ---------------------------------------------------------------------------
// handleClearCommand
// ---------------------------------------------------------------------------

describe('handleClearCommand', () => {
  it('clears context on "clear context"', async () => {
    const { store } = fakeStore();
    const s = createStorage(store);

    await s.setSession({
      conversation: [{ user: 'hi', assistant: 'hello' }],
      activeGoal: 'test',
      formState: {},
    });

    const response = await handleClearCommand('clear context', s);
    expect(response).toBe('Context cleared.');

    const session = await s.getSession();
    expect(session.conversation).toHaveLength(0);
  });

  it('clears on "clear history"', async () => {
    const { store } = fakeStore();
    const s = createStorage(store);

    await s.setSession({
      conversation: [{ user: 'a', assistant: 'b' }],
      activeGoal: 'test',
      formState: {},
    });

    await handleClearCommand('clear history', s);
    const session = await s.getSession();
    expect(session.conversation).toHaveLength(0);
  });

  it('clears on "forget everything"', async () => {
    const { store } = fakeStore();
    const s = createStorage(store);

    await s.setSession({
      conversation: [{ user: 'a', assistant: 'b' }],
      activeGoal: 'test',
      formState: {},
    });

    await handleClearCommand('forget everything', s);
    const session = await s.getSession();
    expect(session.conversation).toHaveLength(0);
  });

  it('returns null for non-clear commands', async () => {
    const { store } = fakeStore();
    const s = createStorage(store);

    const response = await handleClearCommand('find a shirt', s);
    expect(response).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleWhereWasI
// ---------------------------------------------------------------------------

describe('handleWhereWasI', () => {
  it('returns active goal and recent turns', () => {
    const session: SessionState = {
      conversation: [
        { user: 'find a shirt', assistant: 'Found 3 shirts.' },
        { user: 'add to cart', assistant: 'Added to cart.' },
      ],
      activeGoal: 'buying a shirt.',
      formState: {},
    };

    const result = handleWhereWasI('where was I?', session);
    expect(result).toContain('buying a shirt');
    expect(result).toContain('find a shirt');
    expect(result).toContain('add to cart');
  });

  it('returns ERRORS.NO_CONTEXT when no goal and no history', () => {
    const session = emptySession();
    const result = handleWhereWasI('recap', session);
    // Phase H invariant: user-facing strings come from ERRORS constants.
    expect(result).toBe(ERRORS.NO_CONTEXT);
  });

  it('returns ERRORS.WHERE_WAS_I when goal is set (no recent turns)', () => {
    const session: SessionState = {
      conversation: [],
      activeGoal: 'buying shoes.',
      formState: {},
    };
    const result = handleWhereWasI('where was I?', session);
    expect(result).toBe(ERRORS.WHERE_WAS_I('buying shoes', ''));
  });

  it('returns null for non-where-was-I commands', () => {
    const session = emptySession();
    const result = handleWhereWasI('find a shirt', session);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Profile-based fill resolution
// ---------------------------------------------------------------------------

describe('profile-based fill (via actions.ts resolveProfileFields)', () => {
  it('profile:email resolves from chrome.storage.local', async () => {
    // Setup: store a profile in chrome.storage.local
    const profileData = {
      diamond_profile: {
        savedAddresses: [],
        savedLinks: [],
        preferences: { currency: 'USD', language: 'en' },
        email: 'korede@example.com',
        phone: '+234800000000',
      },
    };

    // Mock chrome.storage.local
    const originalChrome = (globalThis as Record<string, unknown>).chrome;
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        local: {
          get: async () => profileData,
          set: async () => {},
          remove: async () => {},
        },
      },
    };

    // Import actions dynamically for the concrete reference
    const actionsModule = await import('../actions');
    const executeAction = actionsModule.executeAction;

    // Create a simple snapshot with one input
    const input = document.createElement('input');
    input.type = 'text';
    const container = document.createElement('div');
    container.appendChild(input);
    document.body.appendChild(container);
    const snap = { structure: '[1] [textbox] ""', elements: [input] };

    const action: DiamondAction = {
      action: 'fill',
      fields: [{ elementIndex: 1, value: 'profile:email' }],
      description: 'Filling email from profile',
    };

    const result = await executeAction(action, snap);

    expect(input.value).toBe('korede@example.com');
    expect(result).toContain('Filling email from profile');

    // Cleanup
    document.body.removeChild(container);
    (globalThis as Record<string, unknown>).chrome = originalChrome;
  });
});
