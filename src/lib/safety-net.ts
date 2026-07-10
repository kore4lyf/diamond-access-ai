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
import * as logger from './logger';

// ---------------------------------------------------------------------------
// Irreversible keywords
// ---------------------------------------------------------------------------

/**
 * Keywords that mark a click as irreversible.
 * Matched case-insensitively against the element's text content.
 *
 * Phase J: `'submit'` was removed — too broad, caused false positives on
 * `<button>Submit comment</button>` etc. Submit buttons are caught by
 * the FormSubmitExemption path now if their form context is a search
 * or login. Truly destructive submits ("Submit purchase", "Submit
 * application", "Submit deletion") still match via the generic text
 * scan because the visible text pairs the keyword with a
 * purchase-style verb.
 */
const IRREVERSIBLE_KEYWORDS = [
  'delete',
  'remove',
  'purchase',
  'pay',
  'cancel order',
  'place order',
  'place your order',
  'buy now',
  'checkout',
  'confirm payment',
  'pay now',
  'make payment',
  'complete purchase',
  'submit application',
  'submit purchase',
  'submit order',
  'send message',
] as const;

/**
 * Form-action URL paths that indicate a non-destructive submit
 * (search, filter, login, etc.). If the click target is a `submit`
 * input/button whose parent form has an action whose path matches
 * any of these, the click is NOT wrapped in confirm.
 */
const REVERSIBLE_FORM_PATHS = [
  '/search',
  '/find',
  '/query',
  '/login',
  '/signin',
  '/auth',
  '/sign-in',
] as const;

/**
 * Determine whether a submit-type element belongs to a non-destructive
 * form (search/filter/login). When so, no confirm prompt is needed.
 */
function isReversibleFormSubmit(el: HTMLElement | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  const type = (el as HTMLInputElement | HTMLButtonElement).type;
  const isSubmitInput =
    (tag === 'INPUT' && type === 'submit') ||
    (tag === 'BUTTON' && type === 'submit');
  if (!isSubmitInput) return false;
  const form = (el as HTMLInputElement | HTMLButtonElement).form;
  if (!form) return false;
  // GET-method forms are nearly always searches / filters.
  if (form.method && form.method.toLowerCase() === 'get') return true;
  // Otherwise check action path against the reversible list.
  const actionAttr = form.getAttribute('action') ?? '';
  if (!actionAttr) return false;
  const path = actionAttr.split('?')[0].toLowerCase();
  return REVERSIBLE_FORM_PATHS.some((p) => path.includes(p));
}

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
  element?: HTMLElement | null,
): DiamondAction {
  // Only click actions can be irreversible
  if (action.action !== 'click') {
    return action;
  }

  // Phase J: form-context exemption. A submit input/button inside a
  // search/filter/login form is reversible — the user is just navigating
  // or submitting credentials, not making a destructive choice. Skip
  // confirm even if any keyword happens to match (e.g. text "Submit").
  if (isReversibleFormSubmit(element ?? null)) {
    logger.info('safety_net', 'form submit exempted (search/filter/login)', {
      description: action.description ?? elementText,
      tag: element?.tagName,
      type: (element as HTMLInputElement | HTMLButtonElement | null)?.type,
      formAction: (element as HTMLInputElement | HTMLButtonElement | null)
        ?.form?.getAttribute('action') ?? null,
      formMethod: (element as HTMLInputElement | HTMLButtonElement | null)
        ?.form?.method ?? null,
    });
    return action;
  }

  // Check if any keyword appears in the element's text (case-insensitive)
  const lowerText = elementText.toLowerCase();
  const matchedKeyword = IRREVERSIBLE_KEYWORDS.find((keyword) =>
    lowerText.includes(keyword),
  );
  const isIrreversible = !!matchedKeyword;

  if (!isIrreversible) {
    return action;
  }

  logger.warn('safety_net', 'irreversible action intercepted', {
    matchedKeyword,
    description: action.description ?? elementText ?? '(no text)',
  });

  // Build a description from the action's description or element text
  const description = action.description || elementText || 'perform this action';

  // Wrap in a confirm action
  return {
    action: 'confirm',
    speech: ERRORS.CONFIRM_PROMPT(description),
    pendingAction: action,
  };
}
