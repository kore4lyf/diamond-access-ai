/**
 * Diamond Access AI — Cross-tab reference parser (Step F-full)
 *
 * Pure-function layer that detects whether a transcript contains a
 * cross-tab reference — a phrase naming some other open tab the user
 * wants context from. The actual tab resolution (matching the parsed
 * fragment against open tabs' titles/URLs) is wired into background.ts
 * because it requires `chrome.tabs.query()`.
 *
 * Phase J + Step F-full condition:
 *   - User said cross-tab inquiry is acceptable IF easy AND doesn't
 *     cause information overload on a normal single-tab request.
 *   - This file is the "easy" half. The "no overload" half is enforced
 *     inside COMMAND_TASK via the CROSS-TAB RULE paragraph.
 *
 * Layering:
 *   parseCrossTabMatches(transcript) → RawCrossTabMatch[]
 *   background.ts#extractCrossTabRefs(transcript) → CrossTabRef[]
 *     (uses parser + chrome.tabs.query + duplicates filter + 2-cap)
 *
 * The parser is intentionally chromeless so it can be unit-tested
 * without mocking the SW environment.
 */

export type CrossTabMatchType = 'ordinal' | 'title-fragment';

export interface RawCrossTabMatch {
  type: CrossTabMatchType;
  /** The matched substring of the transcript (for logging / debugging). */
  rawText: string;
  /**
   * The resolution key that background.ts uses to look up the actual
   * tab:
   *   - 'ordinal'     → the matched digit as a string ("1", "2", ...)
   *   - 'title-fragment' → the matched word in lower-case, suitable
   *     for substring matching against tab.title / tab.url.
   */
  match: string;
}

/**
 * Stopwords that look like content but are too generic to be useful as
 * title fragments (they would match every Amazon tab, every BBC tab,
 * etc.). Cap minimum length at 4 chars to drop most function words
 * automatically; the stopword list catches the long ones ("with",
 * "this", "that", ...).
 *
 * Phase J + Step F-full: this list is small but bounded. New entries
 * should be added only when PC QA shows a false-positive overflow
 * (a stopword matching every open tab). Don't pad.
 */
const STOPWORDS = new Set([
  // 4+ char function words
  'with',
  'this',
  'that',
  'these',
  'those',
  'from',
  'have',
  'what',
  'whats',
  'which',
  'where',
  'about',
  'show',
  'tell',
  'open',
  'there',
  'page',
  'pages',
  'tabs',
  // 3-char function words (needed because we lowered min-length from 4
  // to 3 to support real tab names like "BBC")
  'the',
  'and',
  'for',
  'are',
  'was',
  'but',
  'not',
  'you',
  'all',
  'any',
  'can',
  'had',
  'her',
  'him',
  'his',
  'how',
  'its',
  'may',
  'new',
  'now',
  'old',
  'our',
  'out',
  'say',
  'see',
  'she',
  'too',
  'two',
  'way',
  'who',
  'did',
  'get',
  'let',
  'use',
  'via',
  'yes',
  'one',
  'put',
  'set',
  'try',
  'ask',
]);

/**
 * Parse the user's transcript for cross-tab reference candidates.
 *
 * Returns matches in transcript order. Background.ts will then:
 *   - Deduplicate by tabId when resolving against chrome.tabs.query
 *   - Cap at 2 targets (per Step F-full safeguard: bounded target count)
 *
 * @param transcript - The user's spoken command (post-STT, lower-cased
 *                     by caller if used for match comparison).
 * @returns Match candidates in the order they appear in the transcript.
 */
/**
 * Spelled-out English ordinals (one through nine) — so the user can say
 * "the first tab" or "third tab" naturally. Mapping is small and bounded
 * by design; "the 47th tab" still requires digit form (and is rejected
 * by the upper bound).
 */
const SPELLED_ORDINALS: Readonly<Record<string, number>> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
};

export function parseCrossTabMatches(transcript: string): RawCrossTabMatch[] {
  const matches: RawCrossTabMatch[] = [];

  // Ordinal: digit form OR spelled form. Cap at 1-9.
  //
  // 1. Digit form: "1", "1st", "2nd", "the 5th tab"
  const digitMatch = transcript.match(
    /\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+tab\b/i,
  );
  if (digitMatch) {
    const num = parseInt(digitMatch[1], 10);
    if (num >= 1 && num <= 9) {
      matches.push({
        type: 'ordinal',
        rawText: digitMatch[0],
        match: String(num),
      });
    }
  }

  // 2. Spelled form: "first tab", "the third tab"
  const spelledMatch = transcript.match(
    /\b(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)\s+tab\b/i,
  );
  if (spelledMatch) {
    const num = SPELLED_ORDINALS[spelledMatch[1].toLowerCase()];
    if (num) {
      matches.push({
        type: 'ordinal',
        rawText: spelledMatch[0],
        match: String(num),
      });
    }
  }

  // Title-fragment candidates: words ≥3 chars, alphanumeric, not in
  // STOPWORDS. We don't filter at parse-time by tab-list (we can't —
  // no access to chrome.tabs.query here). Background.ts's extractor
  // does the actual title/URL match.
  //
  // Casing: transcript words are kept lower-case for substring match
  // compatibility with chrome.tabs.query() results.
  //
  // Min length 3 (was 4 in early draft) because real tab names like
  // "BBC", "CNN", "Lyf" are 3 characters. Stopword list below is
  // expanded to cover the common 3-char words so generic language
  // ("the and but") doesn't pollute resolver queries.
  const wordMatches = transcript
    .toLowerCase()
    .split(/\s+/)
    .filter(
      (w) =>
        w.length >= 3 &&
        /^[a-z0-9]+$/.test(w) &&
        !STOPWORDS.has(w),
    );

  for (const w of wordMatches) {
    matches.push({
      type: 'title-fragment',
      rawText: w,
      match: w,
    });
  }

  return matches;
}

/**
 * Sanity check helper (used by background.ts for log noise): is a
 * matched fragment likely to identify a unique tab?
 *
 * For ordinal matches: yes — the index in the tabs array is unique.
 * For title-fragment matches: only if the fragment is long enough to
 * narrow to one tab. "news" might match multiple tabs; "bbc-news"
 * is unlikely to. This is informational, not binding.
 */
export function isUniqueLikelyFragment(fragment: string): boolean {
  return fragment.length >= 6;
}
