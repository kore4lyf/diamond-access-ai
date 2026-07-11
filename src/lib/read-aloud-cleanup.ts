/**
 * Read-aloud cleanup helper — extract the aloud-branch cleanup loop for
 * testability. Background worker can't run in jsdom (needs chrome.*);
 * this pure function can.
 */

import { needsModelCleanup } from './content-chunker';

/**
 * Clean TTS-targeted chunks with optional LLM normalization.
 *
 * @param chunks - The raw chunks to clean.
 * @param hasKey - Whether an API key is configured (skip LLM if false).
 * @param clean - LLM cleanup function; receives chunk, returns cleaned text.
 * @returns Cleaned chunks and flags (true = success, false = cleanup thrown).
 */
export async function cleanChunks(
  chunks: string[],
  hasKey: boolean,
  clean: (c: string) => Promise<string>,
): Promise<{ chunks: string[]; cleanedFlags: boolean[] }> {
  const out: string[] = [];
  const flags: boolean[] = [];

  for (const c of chunks) {
    if (!hasKey || !needsModelCleanup(c)) {
      // No key or no cleanup needed — keep raw, flag success.
      out.push(c);
      flags.push(true);
      continue;
    }

    try {
      const cleaned = await clean(c);
      // Guard: empty string silently drops content. Keep raw instead.
      if (!cleaned || !cleaned.trim()) {
        out.push(c);
        flags.push(true);
        continue;
      }
      out.push(cleaned);
      flags.push(true);
    } catch {
      // Real cleanup failure — keep raw, flag failure.
      out.push(c);
      flags.push(false);
    }
  }

  return { chunks: out, cleanedFlags: flags };
}