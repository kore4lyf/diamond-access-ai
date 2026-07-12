/**
 * Diamond Access AI — Content chunking
 *
 * Phase L (PC-EXT-MAINCONT) — long-form read-aloud + summarize_article.
 *
 * Splits long prose into chunks that fit per-mode limits. The
 * principle (PC-EXT-MAINCONT correction #1): never truncate to fit a
 * limit — partition. Each chunk is within the model's token budget
 * OR (for read-aloud) within the TTS-utterance limit. The union of
 * all chunks = the entire article. Nothing thrown away.
 *
 * Two chunkers, two purposes:
 *   - chunkForRead: TTS-sized utterances. No model in the loop. No
 *     overlap (user would hear the same sentence twice otherwise).
 *   - chunkForSummarize: section-aware overlaps for map-reduce
 *     combine. 10-15% overlap so cross-boundary context isn't lost.
 *
 * Plus:
 *   - modelBudget(model) — per-model token ceiling. Centralizes the
 *     "some models process fewer tokens" concern from PC-QA Round 4.
 *   - needsModelCleanup(chunk) — heuristic regex for symbols/jargon
 *     TTS would mispronounce. Lazy-invokes model cleanup only for
 *     these chunks (cheaper + lower hallucination surface).
 */

import type { MainContent } from './main-content';

// ── Per-model budget ─────────────────────────────────────────────────────
//
// Token budgets that chunker respects. Per the 5-correction plan
// (correction #2): the chunker owns the "some models process fewer
// tokens" concern, not the message handler. To add a new model, just
// append here. Update tests when adding.
//
// Heuristic: production model gets the larger budget because it's
// the one the user actually ships with. Dev fallback is smaller
// because early-stage testing shouldn't bite off more than it can
// chew.
export const MODEL_BUDGETS: Record<string, number> = {
  // Production model — large 8k+ context (lock in DOC-MODEL-ADR.md)
  'accounts/fireworks/models/gemma-4-31b-it': 6000,
  // Dev fallback — MiniMax M3 multimodal, fine for ~4k
  'accounts/fireworks/models/minimax-m3': 4000,
  // Conservative default for unknown / unconfigured models. Prevents
  // a misconfigured user from a single failing-because-budget-too-large
  // LLM call snowballing the chunker.
  __default: 2000,
};

export function modelBudget(model: string | undefined | null): number {
  if (!model) return MODEL_BUDGETS.__default;
  if (MODEL_BUDGETS[model] !== undefined) return MODEL_BUDGETS[model];
  return MODEL_BUDGETS.__default;
}

/**
 * TTS-sized utterance chunks for read-aloud.
 *
 * No overlap (would re-speak the same sentence twice). Splits on
 * sentence boundaries via Intl.Segmenter — handles abbreviations
 * like "Dr.", "U.S.A.", "e.g." correctly per locale. Falls back to
 * a regex-based naive splitter if Intl.Segmenter is unavailable
 * (older Chrome versions, certain bundled test environments).
 *
 * Target ~280 chars per chunk (3-6 sentences avg) — natural stop
 * granularity so user can interject between sentences. Aligns with
 * the gold-standard reference (ReadAloud_ChromeExtension) chunking
 * behavior the PC-EXT-MAINCONT research cited.
 */
export function detectLocale(doc?: Document | null): string {
  const langAttr = doc?.documentElement?.getAttribute('lang') ?? '';
  const primary = langAttr.split('-')[0]?.toLowerCase() ?? '';
  return primary || 'en';
}

export function chunkForRead(
  prose: string,
  opts: { targetChars?: number; locale?: string; doc?: Document | null } = {},
): string[] {
  const targetChars = opts.targetChars ?? 280;
  const locale = opts.locale ?? detectLocale(opts.doc ?? null);

  if (!prose.trim()) return [];

  const Seg = (globalThis as { Intl?: typeof Intl }).Intl?.Segmenter;
  let sentences: string[];
  if (Seg) {
    try {
      const segmenter = new Seg(locale, { granularity: 'sentence' });
      sentences = [];
      for (const seg of segmenter.segment(prose)) {
        const s = seg.segment.trim();
        if (s) sentences.push(s);
      }
    } catch {
      sentences = chunkByRegex(prose);
    }
  } else {
    sentences = chunkByRegex(prose);
  }

  if (sentences.length === 0) return [prose.trim()];

  const chunks: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if (buf === '') {
      buf = s;
    } else if ((buf + ' ' + s).length <= targetChars) {
      buf = buf + ' ' + s;
    } else {
      chunks.push(buf);
      buf = s;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function chunkByRegex(prose: string): string[] {
  // Fallback sentence splitter for envs without Intl.Segmenter.
  // Naive but correct for English (split at `.!?` followed by space
  // and capital). Won't handle all abbreviations but good enough as
  // a safety net so chunker never outright crashes on bare Node.
  return prose
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Section-aware chunks for summarization.
 *
 * Splits on heading/paragraph boundaries (double newlines) first,
 * so topic shifts naturally fall on chunk boundaries. Then
 * fixed-size fallback if a single section exceeds the budget.
 *
 * Reports overlap between adjacent chunks (10-15% by default) so
 * the combine step in map-reduce has cross-boundary context. The
 * overlap is dup'd but the LLM summarizer de-dupes implicitly
 * because it summarizes prose, not echoes it back. This is why
 * read-aloud forbids overlap (TTS would speak it twice) but
 * summarize allows it.
 *
 * Returns ~budget/4-char chunks — leaves 75% of the budget for the
 * LLM response (chunk + 1 passage NPC summary fits).
 */
export function chunkForSummarize(
  prose: string,
  budget: number,
  opts: { overlapFraction?: number; targetFraction?: number } = {},
): string[] {
  const overlapFraction = opts.overlapFraction ?? 0.12;
  const targetFraction = opts.targetFraction ?? 0.25;

  if (!prose.trim()) return [];

  const targetChars = Math.floor(budget * targetFraction);

  // First pass: split on double-newline boundaries (paragraph gaps
  // and artificial heading separators from extractMainContent).
  const parts = prose.split(/\n\n+/);
  const sections: string[] = [];
  let buf = '';
  for (const p of parts) {
    const pt = p.trim();
    if (!pt) continue;
    if (buf === '') {
      buf = pt;
    } else if ((buf + '\n\n' + pt).length <= targetChars) {
      buf = buf + '\n\n' + pt;
    } else {
      sections.push(buf);
      buf = pt;
    }
  }
  if (buf) sections.push(buf);

  // If a single section exploded the budget, hard-split it.
  const finalChunks: string[] = [];
  for (const sec of sections) {
    if (sec.length <= targetChars) {
      finalChunks.push(sec);
      continue;
    }
    // Hard fallback: split on sentence boundaries within the
    // over-budget section.
    const sentences = chunkByRegex(sec);
    let buf2 = '';
    for (const s of sentences) {
      if (buf2 === '') {
        buf2 = s;
      } else if ((buf2 + ' ' + s).length <= targetChars) {
        buf2 = buf2 + ' ' + s;
      } else {
        finalChunks.push(buf2);
        buf2 = s;
      }
    }
    if (buf2) finalChunks.push(buf2);
  }

  // Apply overlap: each chunk's tail seeds the next. Simulated
  // by prepending overlap marker (the LLM treats it as duplicate
  // context and excludes it from the output).
  if (finalChunks.length <= 1 || overlapFraction === 0) return finalChunks;

  const overlapped: string[] = [];
  for (let i = 0; i < finalChunks.length; i++) {
    overlapped.push(finalChunks[i]);
    if (i < finalChunks.length - 1) {
      const tailChars = Math.floor(finalChunks[i].length * overlapFraction);
      const tail = finalChunks[i].slice(-tailChars);
      finalChunks[i + 1] = tail + '\n\n' + finalChunks[i + 1];
    }
  }
  return overlapped;
}

/**
 * Heuristic: does this chunk contain text that TTS would likely
 * mispronounce without normalization?
 *
 * Patterns:
 *   - bullet/symbol chars (•, ★, arrows, nbsp)
 *   - math symbols (∑, √, ∫, ×, ÷, ±, ≠, ≤, ≥, ∞)
 *   - number + spelled-out unit (3 kilometers, 5 degrees, 10 hours)
 *   - emoji + dingbats
 *
 * Does NOT trigger on:
 *   - bare decimals (3.14, 0.5) — read fine as-is
 *   - bare currency (£2, $10.50) — read fine as-is
 *   - bare abbreviations (5 m, 10 kg) — read fine as-is
 *   - standalone unit words without numbers (km, miles) — too ambiguous,
 *     would false-positive on nav labels, headings, etc.
 *
 * Lazy-invoke only when this returns true (correction #1 from you:
 * model in the read path is wasteful — only invoke when needed for
 * cleanup).
 */
export function needsModelCleanup(chunk: string): boolean {
  if (!chunk) return false;
  return (
    /[\u2022\u2023\u2043\u2212\u00a0\u2605\u2606\u2190-\u21ff]/.test(chunk) || // bullets, nbsp, stars, arrows
    /[∑√∫×÷=±≠≤≥∞]/.test(chunk) || // math symbols
    /\d\s+(degrees?|kilometers?|miles?|hours?|minutes?|seconds?|meters?|pounds?|ounces?|kilograms?|grams?)\b/i.test(chunk) || // number + spelled unit
    /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u.test(chunk) // emoji + dingbats
  );
}

/**
 * One-shot helper that picks the right chunker given an intent +
 * budget. Read-only callers use it.
 */
export function partitionProse(
  prose: string,
  intent: 'read_article' | 'summarize_article',
  budget: number,
  opts?: { overlapFraction?: number },
): string[] {
  if (intent === 'summarize_article') {
    return chunkForSummarize(prose, budget, opts);
  }
  return chunkForRead(prose);
}
