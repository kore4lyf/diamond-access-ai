/**
 * LINK_SELECT — LLM-powered link selection
 *
 * Part of Phase K: link-by-description semantic matching.
 *
 * The content script sends a user request + all links to the LLM,
 * which decides which link matches or reports ambiguity. The LLM only
 * returns an index into the provided list (never invents a URL), and
 * this module maps index → actual href + validates.
 *
 * Exported functions are pure and easily unit-tested.
 */

import { ERRORS } from './errors';
import { stripCodeFences, safeJsonParse } from './fireworks';
import type { LinkEntry } from './dom-walk';

export interface LinkSelectResult {
  action: 'navigate' | 'collision' | 'none';
  /** When action='navigate': the selected URL (validated). */
  url?: string;
  /** When action='collision': the matching candidates. */
  candidates?: LinkEntry[];
  /** When action='collision' | 'none': a spoken message. */
  message?: string;
  /** When action='none': the spoken response. */
  speech?: string;
}

/**
 * Parse the LLM's response to a LINK_SELECT request.
 *
 * The LLM must return JSON with one of three shapes:
 *   - {"action":"navigate","index":<N>} where N is 1-based index into links
 *   - {"action":"collision","candidates":[<N>,...],"message":"..."} for ambiguity
 *   - {"action":"none","speech":"..."} when no match
 *
 * We validate every index against the provided links array (guarding against
 * pathological or hallucinated URLs) and map navigate indexes to the real href.
 *
 * @param raw - Raw LLM response (may be fenced, truncated, malformed)
 * @param links - The actual links the user is choosing from (from enumerateLinks)
 * @returns A validated LinkSelectResult
 */
export function parseLinkSelectResponse(
  raw: string,
  links: LinkEntry[],
): LinkSelectResult {
  // Defense: strip code fences first
  const cleaned = stripCodeFences(raw);
  const obj = safeJsonParse(cleaned) as Record<string, unknown> | null;
  if (!obj || typeof obj.action !== 'string') {
    return { action: 'none', speech: ERRORS.LINK_SELECT_FAILED ?? 'I could not find a link for that.' };
  }

  const action = obj.action as string;

  if (action === 'navigate') {
    const idx = typeof obj.index === 'number' ? obj.index : Number(obj.index);
    if (!Number.isInteger(idx) || idx < 1 || idx > links.length) {
      return { action: 'none', speech: ERRORS.LINK_NOT_FOUND ?? 'I could not find that link.' };
    }
    const entry = links[idx - 1];
    const url = entry?.href;
    if (!url) {
      return { action: 'none', speech: ERRORS.LINK_NOT_FOUND ?? 'I could not find that link.' };
    }
    return { action: 'navigate', url };
  }

  if (action === 'collision') {
    const rawCands = Array.isArray(obj.candidates) ? obj.candidates : [];
    // Filter indices to valid range
    const indices = rawCands
      .map((c) => (typeof c === 'number' ? c : Number((c as Record<string, unknown>)?.index)))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= links.length);
    const candidates = indices.map((i) => links[i - 1]).filter(Boolean) as LinkEntry[];
    const message = typeof obj.message === 'string' && obj.message.trim()
      ? obj.message.trim()
      : 'Several links match. Which one?';
    return { action: 'collision', candidates, message };
  }

  if (action === 'none') {
    const speech = typeof obj.speech === 'string' && obj.speech.trim()
      ? obj.speech.trim()
      : 'I could not find a link for that.';
    return { action: 'none', speech };
  }

  // Unknown action — treat as no-match
  return { action: 'none', speech: ERRORS.LINK_SELECT_FAILED ?? 'I could not find a link for that.' };
}