/**
 * Diamond Access AI — Text-format utilities for speech output
 * (Phase J + Round 1B simplification)
 *
 * Strips markdown cruft, code fences, escape sequences, and JSON
 * brackets from raw LLM output before handing it to speechSynthesis.
 *
 * Why this exists: the LLM is told to produce plain prose, but model
 * drift can leak markers (`_underscore_` -> "underscor", `\\` ->
 * "backslash backslash", `**bold**` -> "asterisk asterisk bold ...")
 * through. TTS reads these literally. We saw them on BBC News page-load
 * after Round 1C, and again on Alt+D "summarize this page". This is the
 * post-prompt safety net.
 *
 * Applied once at the speak() boundary in voice.ts so every TTS call
 * passes through the cleaner. Single chokepoint.
 */

/**
 * Strip markdown syntax, JSON-style brackets, accidental escape
 * sequences, and orphan punctuation from raw LLM output.
 *
 * Conservative: identified names (snake_case, kore_4lyf) and middle-of-
 * word underscores stay intact. We only strip `_emphasis_` patterns
 * sandwiched by whitespace or with markdown-style opening/closing pair.
 *
 * @param raw  The raw string from the LLM (or anywhere else)
 * @returns    Prose-safe text suitable to hand to speechSynthesis
 */
export function stripSpokenMarkdown(raw: string): string {
  if (!raw) return '';

  let text = raw;

  // ── Code fences ───────────────────────────────────────────────────────
  // ```lang\n ... \n``` -> empty fences removed, content kept
  text = text.replace(/```[a-zA-Z0-9]*\n?/g, '');
  text = text.replace(/\n?```/g, ' ');

  // ── Inline backticks ─────────────────────────────────────────────────
  // `code` -> code
  text = text.replace(/`{1,3}/g, '');

  // ── Bold / italic (asterisk-pair patterns) ──────────────────────────
  // **foo** -> foo
  text = text.replace(/\*\*([^*\n]+?)\*\*/g, '$1');
  // *foo* -> foo  (only strip when between word boundaries to avoid
  // stripping isolated asterisks that might be meaningful).
  text = text.replace(/\s\*(\S+?)\*\s/g, ' $1 ');
  text = text.replace(/\*\*\s\*\*/g, ''); // empty emphasis

  // ── Underscore emphasis (only boundary cases) ───────────────────────
  // __foo__ -> foo  (rare, but legal in markdown)
  text = text.replace(/__(\S+?)__/g, '$1');
  // _foo_ surrounded by whitespace -> foo.  Inside a word like
  // snake_case_id the underscores are preserved.
  text = text.replace(/\s_(\S+?)_\s/g, ' $1 ');

  // ── Backslashes ─────────────────────────────────────────────────────
  // Escape characters in the LLM output survive somehow (the model
  // wrote them as part of code-style examples, or talked about paths
  // and got tripped up). TTS reads \n as "backslash n" and \\ as
  // "backslash backslash" — disaster for spoken output.
  //
  // Pipeline order matters:
  //   1. \n \t  → space (then whitespace collapse folds runs)
  //   2. \X (other)  → strip the leading \, keep X (path\to\file → pathtofile)
  //   3. bare \ → strip
  text = text.replace(/\\n/g, ' ');
  text = text.replace(/\\t/g, ' ');
  text = text.replace(/\\([a-zA-Z"'\\])/g, '$1');
  text = text.replace(/\\/g, '');

  // ── JSON brackets ──────────────────────────────────────────────────
  // [N] -> N  (numbered list markers, common LLM slip)
  text = text.replace(/\[(\s*\d+\s*)\]/g, '$1');
  // {key: val} -> key: val  (rare but possible)
  text = text.replace(/\{/g, '').replace(/\}/g, '');
  // Standalone "{" or "}" not followed by content -> drop

  // ── Emoji+whitespace collapse ──────────────────────────────────────
  // Collapse runs of whitespace (newlines, tabs, multiple spaces).
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}
