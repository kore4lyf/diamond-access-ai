# Brutal Review + UNHAPPY Tests — Read-Aloud cleanup fix (`3b79a9b`)

Scope: review the developer's committed read-aloud cleanup fix and add
**adversarial / unhappy-path tests** that would have caught the original bug
and that probe residual failure modes. Execution (write tests + run) happens
after this plan is approved; this document is the review + test spec.

## Brutal review of the committed fix

Core fix in `3b79a9b` is **correct**:
- Flag else-branch pushes `true` (not-needed ≠ failed). ✅
- `hasKey` short-circuits the LLM loop when `diamond_api_key` is empty. ✅
- `needsModelCleanup` dropped bare-decimal + bare-unit rules. ✅
- `logger.warn` in catch. ✅

### Findings (real risks the happy path hides)

**F1 — Stale/misleading comment (code-correct, comment-wrong).**
`content-chunker.ts:224-228` still documents `decimal math (3.14)` and
`units (°C, km, €)` as flagged patterns. The code no longer flags them. A
future dev trusting the comment will "fix" the wrong thing. → Update comment
to match C (bullets/nbsp/arrows, math *symbols*, spelled units, emoji).

**F2 — Silent content drop on empty cleanup result (no throw).**
`background.ts:1119` does `cleaned.push(cleanedText)`. If the LLM normalizer
returns `""` (valid response, no exception), that chunk becomes empty and TTS
speaks nothing — content is lost without a failure flag. `fireworks.ts` only
throws on `null` content, not `""`. → Guard: if `cleanedText` is empty, keep
raw and flag `true`.

**F3 — Blank/whitespace API key not treated as missing.**
`Boolean(' ')` (background.ts:1108) and `!apiKey` (fireworks.ts:336) treat a
spaces-only key as valid. Result: the doomed auth-fail loop runs again → the
exact "17 parts raw" class of bug returns for users who saved a blank key.
→ Trim the key: `Boolean((diamond_api_key ?? '').trim())`, and in fireworks
treat blank the same as missing.

**F4 — Zero tests for the fixed logic.**
No `content-chunker.test.ts`, no flag-semantics test. The brief's Verification
step is unmet, so the fix can silently regress.

## UNHAPPY tests to add

### File A: `src/lib/__tests__/content-chunker.test.ts` (NEW)
`needsModelCleanup` adversarial cases:
- `''` → `false`
- `'   \n  '` (whitespace only) → `false`
- `'The cat sat on the mat and watched the rain.'` (plain English) → `false`
- `'It was 3.14 meters away.'` → `false`  *(bare decimal dropped — confirms C)*
- `'Price is £2 and 5 m long.'` → `false`  *(bare currency/unit)*
- `'Temp 5°C today.'` → `false`  *(° glyph no longer flagged — confirms C)*
- `'• one\n• two'` → `true`  (bullet)
- `'∑x = 0'` → `true`  (math symbol)
- `'10 degrees outside'` → `true`  (spelled unit)
- `'Launch 🚀 now'` → `true`  (emoji)
- `'\u00a0'` (nbsp) → `true`
- `'km'` alone → `false`  (bare unit, NOT spelled "kilometers")

`detectLocale` unhappy cases:
- `detectLocale(null)` → `'en'`
- `detectLocale(documentWithoutLang)` → `'en'`
- `detectLocale(doc lang='EN-US')` → `'en'`
- `detectLocale(doc lang='')` → `'en'`

`chunkForRead` unhappy cases:
- `chunkForRead('')` → `[]`
- `chunkForRead('OneGiantRunOnSentenceWithNoTerminalPunctuation')` → `[prose]`
  (single chunk, no sentence boundary — must not crash/loop)
- `chunkForRead(prose, { locale: 'zz' })` (unsupported locale) → returns an
  array, does **not throw** (Intl.Segmenter try/catch fallback)
- normal multi-sentence paragraph → `length >= 2`

### File B: `src/lib/__tests__/read-aloud-cleanup.test.ts` (NEW, needs helper)
Extract the aloud cleanup loop into a pure function so it's testable in jsdom
(`background.ts` can't be imported — needs `chrome.*`/Fireworks):

New `src/lib/read-aloud-cleanup.ts`:
```ts
export async function cleanChunks(
  chunks: string[],
  hasKey: boolean,
  clean: (c: string) => Promise<string>,
): Promise<{ chunks: string[]; cleanedFlags: boolean[] }> {
  const out: string[] = [];
  const flags: boolean[] = [];
  for (const c of chunks) {
    if (!hasKey || !needsModelCleanup(c)) {
      out.push(c); flags.push(true); continue;
    }
    try {
      const cleaned = await clean(c);
      if (!cleaned.trim()) { out.push(c); flags.push(true); continue; } // F2 guard
      out.push(cleaned); flags.push(true);
    } catch {
      out.push(c); flags.push(false); // real failure — keep raw
    }
  }
  return { chunks: out, cleanedFlags: flags };
}
```
`background.ts` calls `cleanChunks(chunks, hasKey, (c) => callLLMWithRetry(SYSTEM, c))`.

Unhappy tests (these are the brutal ones — several expose F2/F3 until guarded):
- `hasKey=false` + chunk that **needs** cleanup → flag is `true`
  (regression of the original bug: previously this was counted as a failure).
- 50 flagged chunks, `hasKey=false` → **all** flags `true`, `false`-count `0`.
- `hasKey=true` + `clean` **throws** → flag `false`, returned chunk `=== raw`
  (never drop content).
- `hasKey=true` + `clean` returns `''` (empty, no throw) → returned chunk
  `=== raw`, flag `true`  **(exposes F2 — fails until guard added)**.
- blank key `' '` treated as `hasKey=false` → all flags `true`
  **(exposes F3 — fails until key is trimmed)**.
- `hasKey=true` + `clean` returns cleaned text → flag `true`, chunk `=== cleaned`.

## Code edits required alongside (to make unhappy tests pass)
1. `content-chunker.ts:224-228` — fix stale comment (F1).
2. `src/lib/read-aloud-cleanup.ts` — add F2 empty-result guard (built into helper above).
3. `background.ts:1107-1108` — `const hasKey = Boolean((diamond_api_key ?? '').trim());` (F3).
4. `fireworks.ts:336` — `if (!(apiKey ?? '').trim())` (F3, symmetry).

## Run / verify
```bash
# new unhappy tests
pnpm test -- --run src/lib/__tests__/content-chunker.test.ts src/lib/__tests__/read-aloud-cleanup.test.ts
# full suite + gates
pnpm test -- --run
pnpm run typecheck
pnpm build
```
Manual (browser): with `diamond_api_key` empty or blank → read article →
*"Finished reading."* (no count). With key + healthy quota → numeric BBC
article → cleaned silently or an accurate small count.
