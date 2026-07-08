/**
 * Diamond Access AI — Fireworks API Client Tests
 *
 * Phase C: Unit tests for callLLMCore, callLLM, callLLMWithRetry, tryParseJSON.
 * All tests run under vitest + jsdom — no browser, no live API calls.
 *
 * Per DOC-FIREWORKS-INTEGRATION §1.1:
 *   Mock `fetch` in unit tests. Live calls cost real money against the $50 credit.
 *   The single sanctioned live test is doc/PC-QA-TEST.md PC-C-1 (PC only).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  callLLMCore,
  callLLM,
  callLLMWithRetry,
  tryParseJSON,
  FIREWORKS_URL,
  DEV_MODEL_ID,
} from '../fireworks';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Mock fetch instance with typed mock methods preserved. */
type MockFetch = ReturnType<typeof vi.fn>;

/** Create a mock fetch that returns a given content string. */
function mockFetchOk(content: string): MockFetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        choices: [{ message: { content } }],
      }),
    text: () => Promise.resolve(''),
  });
}

/** Create a mock fetch with an HTTP error status. */
function mockFetchError(
  status: number,
  body: string,
): MockFetch {
  return vi.fn().mockResolvedValue({
    ok: false as const,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(body),
  });
}

/** Cast a MockFetch to typeof fetch for passing to callLLMCore. */
function asFetch(mock: MockFetch): typeof fetch {
  return mock as unknown as typeof fetch;
}

/** Mock chrome.storage.local with the given data. */
function mockChromeStorage(data: Record<string, unknown>): void {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi
          .fn()
          .mockImplementation((_keys: string | string[]) =>
            Promise.resolve(data),
          ),
      },
    },
  });
}

/** Mock a successful chrome storage read (API key present). */
function mockKeyPresent(): void {
  mockChromeStorage({ diamond_api_key: 'test-key-abc123' });
}

/** Mock chrome storage with no API key. */
function mockKeyMissing(): void {
  mockChromeStorage({});
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Smoke
// ---------------------------------------------------------------------------

describe('smoke', () => {
  it('1 + 1 === 2', () => {
    expect(1 + 1).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// tryParseJSON
// ---------------------------------------------------------------------------

describe('tryParseJSON', () => {
  it('parses a simple JSON object', () => {
    const result = tryParseJSON('{"a":1}');
    expect(result).toEqual({ a: 1 });
  });

  it('returns null for non-JSON text', () => {
    expect(tryParseJSON('nope')).toBeNull();
  });

  it('trims whitespace before parsing', () => {
    const result = tryParseJSON('  {"a":1}  ');
    expect(result).toEqual({ a: 1 });
  });

  it('returns null for empty string', () => {
    expect(tryParseJSON('')).toBeNull();
  });

  it('returns null for invalid JSON even if it starts with {', () => {
    expect(tryParseJSON('{invalid}')).toBeNull();
  });

  it('parses nested objects', () => {
    const result = tryParseJSON('{"ok":true,"data":{"count":5}}');
    expect(result).toEqual({ ok: true, data: { count: 5 } });
  });

  it('returns null for JSON arrays (do not start with {)', () => {
    expect(tryParseJSON('[1,2,3]')).toBeNull();
  });

  it('returns null for JSON primitives', () => {
    expect(tryParseJSON('"string"')).toBeNull();
    expect(tryParseJSON('42')).toBeNull();
    expect(tryParseJSON('true')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// callLLMCore — pure function, mock fetch only
// ---------------------------------------------------------------------------

describe('callLLMCore', () => {
  it('returns content on successful response', async () => {
    const fetchMock = mockFetchOk('Hello from Fireworks');
    const result = await callLLMCore(
      'You are a helper.',
      'Say hello',
      'key-1',
      DEV_MODEL_ID,
      asFetch(fetchMock),
    );

    expect(result).toBe('Hello from Fireworks');

    // Verify fetch was called with correct URL and headers
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(FIREWORKS_URL);
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer key-1');
    expect(opts.headers['Content-Type']).toBe('application/json');

    // Verify body structure
    const body = JSON.parse(opts.body);
    expect(body.model).toBe(DEV_MODEL_ID);
    expect(body.max_tokens).toBe(1024);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
  });

  it('throws Fireworks API error on 401', async () => {
    const fetchMock = mockFetchError(401, 'unauthorized');

    await expect(
      callLLMCore('sys', 'user', 'bad-key', DEV_MODEL_ID, asFetch(fetchMock)),
    ).rejects.toThrow('Fireworks API error 401: unauthorized');
  });

  it('throws Fireworks API error on 500', async () => {
    const fetchMock = mockFetchError(500, 'Internal Server Error');

    await expect(
      callLLMCore('sys', 'user', 'key', DEV_MODEL_ID, asFetch(fetchMock)),
    ).rejects.toThrow('Fireworks API error 500: Internal Server Error');
  });

  it('throws Malformed Fireworks response when choices is empty', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [] }),
      text: () => Promise.resolve(''),
    });

    await expect(
      callLLMCore('sys', 'user', 'key', DEV_MODEL_ID, asFetch(fetchMock)),
    ).rejects.toThrow('Malformed Fireworks response');
  });

  it('throws Malformed Fireworks response when content is missing', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: {} }] }),
      text: () => Promise.resolve(''),
    });

    await expect(
      callLLMCore('sys', 'user', 'key', DEV_MODEL_ID, asFetch(fetchMock)),
    ).rejects.toThrow('Malformed Fireworks response');
  });

  it('throws Malformed Fireworks response when data is null', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(null),
      text: () => Promise.resolve(''),
    });

    await expect(
      callLLMCore('sys', 'user', 'key', DEV_MODEL_ID, asFetch(fetchMock)),
    ).rejects.toThrow('Malformed Fireworks response');
  });

  it('throws when fetch itself fails (network error)', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockRejectedValue(new Error('Network failure'));

    await expect(
      callLLMCore('sys', 'user', 'key', DEV_MODEL_ID, asFetch(fetchMock)),
    ).rejects.toThrow('Network failure');
  });
});

// ---------------------------------------------------------------------------
// callLLM — wrapper, needs mocked chrome.storage
// ---------------------------------------------------------------------------

describe('callLLM', () => {
  it('throws API key not configured when key is missing', async () => {
    mockKeyMissing();
    vi.stubGlobal('fetch', mockFetchOk('irrelevant'));

    await expect(
      callLLM('system', 'user message'),
    ).rejects.toThrow('API key not configured. Open extension settings.');
  });

  it('calls callLLMCore with key from storage and returns content', async () => {
    mockKeyPresent();
    const fetchMock = mockFetchOk('OK');
    vi.stubGlobal('fetch', fetchMock);

    const result = await callLLM('sys', 'user');

    expect(result).toBe('OK');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Verify the bearer token from chrome.storage was used
    const opts = fetchMock.mock.calls[0][1];
    expect(opts.headers.Authorization).toBe('Bearer test-key-abc123');
  });

  it('uses explicit model parameter over storage default', async () => {
    mockKeyPresent();
    const fetchMock = mockFetchOk('OK');
    vi.stubGlobal('fetch', fetchMock);
    const customModel = 'accounts/fireworks/models/some-other-model';

    await callLLM('sys', 'user', customModel);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe(customModel);
  });

  it('falls back to DEV_MODEL_ID when no model in storage and no param', async () => {
    mockKeyPresent();
    const fetchMock = mockFetchOk('OK');
    vi.stubGlobal('fetch', fetchMock);

    await callLLM('sys', 'user');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe(DEV_MODEL_ID);
  });
});

// ---------------------------------------------------------------------------
// callLLMWithRetry
// ---------------------------------------------------------------------------

describe('callLLMWithRetry', () => {
  it('succeeds on first attempt with valid JSON response', async () => {
    mockKeyPresent();
    vi.stubGlobal('fetch', mockFetchOk('{"ok":true}'));

    const result = await callLLMWithRetry('sys', 'do something');

    expect(result).toBe('{"ok":true}');
  });

  it('retries on malformed JSON and returns valid JSON from second attempt', async () => {
    mockKeyPresent();

    // First call returns invalid JSON, second returns valid JSON
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ choices: [{ message: { content: 'not json' } }] }),
        text: () => Promise.resolve(''),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: '{"ok":true}' } }],
          }),
        text: () => Promise.resolve(''),
      });

    vi.stubGlobal('fetch', fetchMock);

    const result = await callLLMWithRetry('sys', 'do something');

    // Should return the valid JSON from second attempt
    expect(result).toBe('{"ok":true}');

    // Should have called fetch twice
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries on HTTP failure and returns result from second attempt', async () => {
    mockKeyPresent();

    // First call fails with 500, second succeeds
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve('Internal error'),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => {
          const responseData = {
            choices: [{ message: { content: '{"ok":true}' } }],
          };
          return Promise.resolve(responseData);
        },
        text: () => Promise.resolve(''),
      });

    vi.stubGlobal('fetch', fetchMock);

    const result = await callLLMWithRetry('sys', 'do something');

    expect(result).toBe('{"ok":true}');
  });

  it('throws Fireworks API call failed after all attempts exhausted', async () => {
    mockKeyPresent();

    // Both attempts throw network errors
    const fetchMock = vi.fn();
    fetchMock
      .mockRejectedValueOnce(new Error('Network failure'))
      .mockRejectedValueOnce(new Error('Network failure'));

    vi.stubGlobal('fetch', fetchMock);

    await expect(
      callLLMWithRetry('sys', 'do something'),
    ).rejects.toThrow('Fireworks API call failed');
  });

  it('returns raw text on last attempt if JSON parse still fails', async () => {
    mockKeyPresent();

    // Both attempts return non-JSON text
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'not json attempt 1' } }],
          }),
        text: () => Promise.resolve(''),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'not json attempt 2' } }],
          }),
        text: () => Promise.resolve(''),
      });

    vi.stubGlobal('fetch', fetchMock);

    // With retries=1, first attempt: "not json attempt 1" -> not JSON -> re-prompt
    // Second attempt: "not json attempt 2" -> not JSON -> retries exhausted -> return raw
    const result = await callLLMWithRetry('sys', 'do something');

    expect(result).toBe('not json attempt 2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('respects custom retry count', async () => {
    mockKeyPresent();

    // Three failures, retries=2 means 3 attempts total
    const fetchMock = vi.fn();
    fetchMock
      .mockRejectedValueOnce(new Error('Fail 1'))
      .mockRejectedValueOnce(new Error('Fail 2'))
      .mockRejectedValueOnce(new Error('Fail 3'));

    vi.stubGlobal('fetch', fetchMock);

    await expect(
      callLLMWithRetry('sys', 'do something', 2),
    ).rejects.toThrow('Fireworks API call failed');

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
