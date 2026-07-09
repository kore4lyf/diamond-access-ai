/**
 * Diamond Access AI — Irreversible-Action Safety Net
 *
 * Phase H: Client-side keyword detector that catches click actions on
 * submit/delete/purchase elements and forces confirmation — even if the
 * LLM didn't use the `confirm` schema.
 *
 * Principle (DOC-CALL-STRATEGY §6.1 / DOC-AGENT-BEHAVIOR §4.4):
 *   The LLM is *supposed* to use `confirm` for irreversible actions.
 *   This safety net catches cases where it didn't. It is a last line of
 *   defense, not a feature — the system prompt should already handle this.
 *
 * Limitation:
 *   This is a keyword match, not a semantic check. An element labeled "✓"
 *   that submits a form won't match unless "submit" is also in its text.
 *   Demo pages should be chosen so the keywords are present in button text.
 */

import { ERRORS } from './errors';
import type { DiamondAction } from './actions';

// ---------------------------------------------------------------------------
// Irreversible keywords
// ---------------------------------------------------------------------------

/**
 * Keywords that mark a click as irreversible.
 * Matched case-insensitively against the element's text content.
 */
const IRREVERSIBLE_KEYWORDS = [
  'submit',
  'delete',
  'purchase',
  'pay',
  'send',
  'cancel order',
  'place order',
  'buy now',
  'checkout',
  'confirm payment',
  'pay now',
  'make payment',
  'complete purchase',
] as const;

// ---------------------------------------------------------------------------
// wrapIrreversible
// ---------------------------------------------------------------------------

/**
 * Check if a click action targets an irreversible element and wrap it
 * in a confirmation flow.
 *
 * @param action      - The parsed action from the LLM
 * @param elementText - The text content / description of the target element
 * @returns The original action (if safe) or a wrapped confirm action
 *
 * @example
 * ```ts
 * const safe = wrapIrreversible(
 *   { action: 'click', elementIndex: 1, description: 'Buy Now' },
 *   '[Button] \"Buy Now\"'
 * );
 * // safe => { action: 'confirm', speech: "This will Buy Now. Say 'confirm' to proceed.", pendingAction: { action: 'click', ... } }
 * ```
 */
export function wrapIrreversible(
  action: DiamondAction,
  elementText: string,
): DiamondAction {
  // Only click actions can be irreversible
  if (action.action !== 'click') {
    return action;
  }

  // Check if any keyword appears in the element's text (case-insensitive)
  const lowerText = elementText.toLowerCase();
  const isIrreversible = IRREVERSIBLE_KEYWORDS.some((keyword) =>
    lowerText.includes(keyword),
  );

  if (!isIrreversible) {
    return action;
  }

  // Build a description from the action's description or element text
  const description = action.description || elementText || 'perform this action';

  // Wrap in a confirm action
  return {
    action: 'confirm',
    speech: ERRORS.CONFIRM_PROMPT(description),
    pendingAction: action,
  };
}
