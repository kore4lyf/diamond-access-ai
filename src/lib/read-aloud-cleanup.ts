/**
 * Read-aloud cleanup helper — extract the aloud-branch cleanup loop for
 * testability. Background worker can't run in jsdom (needs chrome.*);
 * this pure function can.
 *
 * Flag semantics (cleanedFlags):
 *   false = chunk was successfully cleaned by LLM (modified)
 *   true  = chunk was kept raw (skipped: no key / no cleanup needed, or failed)
 *
 * content.ts uses `flags.filter(f => !f).length` to count cleaned chunks,
 * and `flags.filter(f => f).length` to count raw-kept chunks.
 */

import { needsModelCleanup } from './content-chunker';

/**
 * Clean TTS-targeted chunks with optional LLM normalization.
 *
 * @param chunks - The raw chunks to clean.
 * @param hasKey - Whether an API key is configured (skip LLM if false).
 * @param clean - LLM cleanup function; receives chunk, returns cleaned text.
 * @returns Cleaned chunks and flags.
 *          cleanedFlags[i]: false = cleaned (LLM modified), true = raw (skipped or failed).
 */
export interface CleanChunksResult {
  chunks: string[];
  /** false = cleaned by LLM, true = kept raw (skipped or failed). */
  cleanedFlags: boolean[];
  /** Number of chunks kept raw because no API key was configured. */
  noKeyCount: number;
}

export async function cleanChunks(
  chunks: string[],
  hasKey: boolean,
  clean: (c: string) => Promise<string>,
): Promise<CleanChunksResult> {
  const out: string[] = [];
  const flags: boolean[] = [];
  let noKeyCount = 0;

  for (const c of chunks) {
    if (!hasKey) {
      // No API key — keep raw, flag as raw (no LLM available).
      out.push(c);
      flags.push(true);
      noKeyCount++;
      continue;
    }

    if (!needsModelCleanup(c)) {
      // Cleanup not needed — keep raw, flag as raw (already clean).
      out.push(c);
      flags.push(true);
      continue;
    }

    try {
      const cleaned = await clean(c);
      // Guard: empty string silently drops content. Keep raw instead.
      if (!cleaned || !cleaned.trim()) {
        out.push(c);
        flags.push(true); // raw — LLM returned empty, fell back to original
        continue;
      }
      out.push(cleaned);
      flags.push(false); // cleaned — LLM successfully modified this chunk
    } catch {
      // Real cleanup failure — keep raw, flag failure.
      out.push(c);
      flags.push(true); // raw — LLM call threw
    }
  }

  return { chunks: out, cleanedFlags: flags, noKeyCount };
}