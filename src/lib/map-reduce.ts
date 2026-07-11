/**
 * Diamond Access AI — Map-reduce summarization
 *
 * Phase L (PC-EXT-MAINCONT) — long-form read-aloud + summarize_article.
 *
 * For summarize_article, summarize every chunk in parallel via the
 * callLLMWithRetry helper, then combine the chunk-summaries
 * recursively until the result fits the budget. No content lost.
 *
 * Why map-reduce (not Refine or progressive-cumulation, per
 * PC-EXT-MAINCONT research): map-reduce isolates work per chunk,
 * parallelizes safely, and the cost is bounded by chunk count.
 * Refine-style progressive prompts grow the prompt with each step
 * and would compound cost on long articles.
 *
 * Sharing the callLLMWithRetry wrapper from `storage/callLLM` so
 * the existing retry + parse-error handling applies uniformly.
 */

import { chunkForSummarize, modelBudget } from './content-chunker';

/**
 * The summarization LLM call shape — kept abstract so unit tests
 * can inject a mock without standing up chrome.runtime.
 */
export type SummarizeFn = (
  systemPrompt: string,
  userMessage: string,
) => Promise<string>;

const MAP_HEADER = `TASK: Summarize the following prose in 2-4 sentences. Plain English, no lists, no jargon, no invented names. If a sentence makes a claim you can't verify from the prose, drop it.`;

const COMBINE_HEADER = `TASK: Combine these chunk-summaries into one coherent 2-4 sentence summary. Plain English, no lists. Preserve the most important point from across all chunks in the FIRST sentence; drop redundant mentions.`;

/**
 * Map step: summarize a single chunk.
 */
async function mapOne(
  chunk: string,
  fn: SummarizeFn,
): Promise<string> {
  const user = `${MAP_HEADER}\n\nPROSE:\n${chunk}`;
  return fn(MAP_HEADER, user);
}

/**
 * Reduce step: bundle chunk-summaries that fit, summarize each
 * bundle, recurse if multiple bundles remain.
 *
 * The bundle target is budget / 3 so reserve 2/3 of budget for the
 * LLM response + system prompt overhead. Each combine request
 * processes a bounded amount of input, so recursion is finite.
 */
async function combine(
  summaries: string[],
  budget: number,
  fn: SummarizeFn,
): Promise<string> {
  if (summaries.length === 0) return '';
  if (summaries.length === 1) return summaries[0];

  // Bundle per-budget
  const targetPerBundle = Math.max(640, Math.floor(budget / 3));
  const bundles: string[][] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const s of summaries) {
    if (current.length === 0) {
      current = [s];
      currentLen = s.length;
    } else if (currentLen + s.length + 2 <= targetPerBundle) {
      current.push(s);
      currentLen += s.length + 2; // +2 for the '\n\n' separator
    } else {
      bundles.push(current);
      current = [s];
      currentLen = s.length;
    }
  }
  if (current.length) bundles.push(current);

  const reduced = await Promise.all(
    bundles.map(async (bundle) => {
      const joined = bundle.join('\n\n');
      const user = `${COMBINE_HEADER}\n\nCHUNK SUMMARIES:\n${joined}`;
      return fn(COMBINE_HEADER, user);
    }),
  );

  if (reduced.length === 1) return reduced[0];
  return combine(reduced, budget, fn);
}

/**
 * Top-level entry: chunk the prose (section-aware + overlap), map
 * each chunk, combine until ≤ budget.
 *
 * Returns "" for empty prose. Never throws — failures from the LLM
 * caller are surfaced through the SummarizeFn rejection, leaving
 * the caller to apply graceful-degradation (the SW handler does).
 */
export async function summarizeChunks(
  prose: string,
  model: string,
  fn: SummarizeFn,
): Promise<string> {
  if (!prose.trim()) return '';
  const budget = modelBudget(model);
  const chunks = chunkForSummarize(prose, budget);

  // 0-1 chunk case: skip the map step.
  if (chunks.length === 0) return '';
  if (chunks.length === 1) {
    return mapOne(chunks[0], fn);
  }

  const chunkSummaries = await Promise.all(
    chunks.map((c) => mapOne(c, fn)),
  );

  return combine(chunkSummaries, budget, fn);
}

/**
 * Read-aloud path: chunk the prose into TTS-sized utterances.
 * Returns plain-ready-to-speak chunks — no model in the loop.
 *
 * (Read path doesn't use this module's reduce phase because
 * there's no combine for TTS — the user hears chunks sequentially
 * with stop capability, see content.ts streamReadAloud.)
 */
export function readAloudChunks(
  prose: string,
): string[] {
  // chunkForRead lives in content-chunker; re-export here so the
  // SW handler has a single import surface for both intents.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { chunkForRead } = require('./content-chunker') as {
    chunkForRead: (p: string) => string[];
  };
  return chunkForRead(prose);
}
