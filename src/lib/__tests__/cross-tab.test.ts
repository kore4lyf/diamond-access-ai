/**
 * Diamond Access AI — Cross-tab reference parser tests (Step F-full)
 *
 * Phase J + Step F-full: parseCrossTabMatches is a pure-function
 * detector for cross-tab references in user transcripts. The layer
 * that actually resolves those references against chrome.tabs.query()
 * lives in background.ts and isn't unit-tested here (it would need
 * a chrome.* mock harness).
 */

import { describe, it, expect } from 'vitest';
import {
  parseCrossTabMatches,
  isUniqueLikelyFragment,
} from '../cross-tab';

// ---------------------------------------------------------------------------
// parseCrossTabMatches — ordinal detection
// ---------------------------------------------------------------------------

describe('parseCrossTabMatches — ordinal', () => {
  it('matches "the first tab"', () => {
    const m = parseCrossTabMatches('what is on the first tab');
    const ord = m.filter((x) => x.type === 'ordinal');
    expect(ord).toHaveLength(1);
    expect(ord[0].match).toBe('1');
  });

  it('matches "1st tab"', () => {
    const m = parseCrossTabMatches('compare with 1st tab');
    expect(m.some((x) => x.type === 'ordinal' && x.match === '1')).toBe(true);
  });

  it('matches "the 2nd tab"', () => {
    const m = parseCrossTabMatches('read the 2nd tab');
    expect(m.some((x) => x.type === 'ordinal' && x.match === '2')).toBe(true);
  });

  it('matches "third tab"', () => {
    const m = parseCrossTabMatches('open the third tab and read');
    expect(m.some((x) => x.type === 'ordinal' && x.match === '3')).toBe(true);
  });

  it('rejects "0th tab" (out-of-range)', () => {
    const m = parseCrossTabMatches('compare to 0th tab');
    expect(m.filter((x) => x.type === 'ordinal')).toHaveLength(0);
  });

  it('rejects "the 12th tab" (over 9 cap)', () => {
    const m = parseCrossTabMatches('open the 12th tab');
    expect(m.filter((x) => x.type === 'ordinal')).toHaveLength(0);
  });

  it('handles bare "tab" without ordinal correctly', () => {
    const m = parseCrossTabMatches('what is on this tab');
    expect(m.filter((x) => x.type === 'ordinal')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseCrossTabMatches — title-fragment detection
// ---------------------------------------------------------------------------

describe('parseCrossTabMatches — title fragment', () => {
  it('extracts short candidates like "bbc"', () => {
    const m = parseCrossTabMatches('whats on bbc');
    expect(m.some((x) => x.type === 'title-fragment' && x.match === 'bbc')).toBe(true);
  });

  it('extracts candidates around an ordinal', () => {
    const m = parseCrossTabMatches('compare the first tab bbc with google');
    const frags = m.filter((x) => x.type === 'title-fragment');
    expect(frags.some((x) => x.match === 'bbc')).toBe(true);
    expect(frags.some((x) => x.match === 'google')).toBe(true);
  });

  it('skips stopwords', () => {
    const m = parseCrossTabMatches('what is on it');
    // No fragments: "what", "is", "on", "it" — all <4 chars OR stopwords.
    expect(m.filter((x) => x.type === 'title-fragment')).toHaveLength(0);
  });

  it('catches long stopwords by listing', () => {
    // Edge case: "with" is 4 chars but in the stopword list.
    const m = parseCrossTabMatches('with the docs');
    expect(m.some((x) => x.type === 'title-fragment' && x.match === 'with')).toBe(false);
    expect(m.some((x) => x.type === 'title-fragment' && x.match === 'docs')).toBe(true);
  });

  it('skips non-alphanumeric content', () => {
    const m = parseCrossTabMatches('read tab "my-doc.pdf"');
    const pdf = m.find((x) => x.match === 'pdf');
    // "pdf" is 3 chars; filtered by min-length.
    expect(pdf).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseCrossTabMatches — empty / no cross-tab intent
// ---------------------------------------------------------------------------

describe('parseCrossTabMatches — default-path equivalence', () => {
  it('returns no ordinal for "summarize this page"', () => {
    const ord = parseCrossTabMatches('summarize this page').filter(
      (x) => x.type === 'ordinal',
    );
    expect(ord).toHaveLength(0);
  });

  it('returns no ordinal for "add to cart"', () => {
    const ord = parseCrossTabMatches('add to cart').filter(
      (x) => x.type === 'ordinal',
    );
    expect(ord).toHaveLength(0);
  });

  it('returns fragment matches even for ordinary commands (background.ts dedupes)', () => {
    // Pure parser intent: list candidates. Background.ts applies
    // the 2-cap and uses seeTabIds. So even if "summarize this page"
    // yields fragments, background.ts extractor handles those.
    const m = parseCrossTabMatches('summarize this page');
    // "summarize", "this", "page" — last two are stopwords, "summarize" is 10 chars, valid fragment.
    expect(m.some((x) => x.type === 'title-fragment' && x.match === 'summarize')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isUniqueLikelyFragment — informational helper
// ---------------------------------------------------------------------------

describe('isUniqueLikelyFragment', () => {
  it('returns true for ≥6 char fragments', () => {
    expect(isUniqueLikelyFragment('bbc-news')).toBe(true);
  });

  it('returns false for short fragments', () => {
    expect(isUniqueLikelyFragment('news')).toBe(false);
  });
});
