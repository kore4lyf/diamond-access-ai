/**
 * Diamond Access AI — Action Execution Engine
 *
 * Phase F: Turns Phase E's parsed action JSON into real DOM operations.
 * All action execution happens in the content script (it has the DOM).
 * The service worker only decides *what* to do — Phase F implements *how*.
 *
 * Architecture (§DOC-CALL-STRATEGY §5, §6, §7):
 *   executeAction(action, snapshot)  — single dispatcher
 *     → clickAction / navigateAction / fillAction / confirmAction
 *     → each returns a human-readable result string
 *
 * Guardrails:
 *   - No LLM calls (Fireworks imports)
 *   - No chrome.* APIs
 *   - No speechSynthesis — just returns strings for the caller to speak
 *   - javascript: URLs are always refused
 *   - Sensitive field values are never spoken in full
 */

import { ERRORS } from './errors';
import type { PageSnapshot } from './page-snapshot';
import * as logger from './logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FillField {
  elementIndex: number;
  value: string;
}

export type DiamondAction =
  | { action: 'none'; speech: string }
  | { action: 'navigate'; url: string; description: string }
  | { action: 'click'; elementIndex: number; description: string }
  | { action: 'fill'; fields: FillField[]; description: string }
  | { action: 'confirm'; speech: string; pendingAction: DiamondAction };

// ---------------------------------------------------------------------------
// Module state (confirmation flow)
// ---------------------------------------------------------------------------

/**
 * A pending action awaiting verbal confirmation.
 * Set by confirmAction or by sensitive-field detection in fillAction.
 * Cleared when the user confirms or cancels.
 */
let pendingConfirm: DiamondAction | null = null;

// ---------------------------------------------------------------------------
// Confirmation phrasing
// ---------------------------------------------------------------------------

const CONFIRM_PHRASES = new Set([
  'yes', 'yeah', 'confirm', 'go ahead', 'do it', 'proceed',
  'sure', 'ok', 'okay', 'yes please', 'please do', 'yep',
  'confirmed', 'confirm it', 'do it please',
]);

// ---------------------------------------------------------------------------
// Public API — dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch a DiamondAction to the right executor.
 *
 * @param action  - The parsed action object from the LLM
 * @param snapshot - PageSnapshot from buildPageSnapshot() (for element resolution)
 * @returns A human-readable result string to speak to the user
 */
export async function executeAction(
  action: DiamondAction,
  snapshot: PageSnapshot,
): Promise<string> {
  const sw = new logger.Stopwatch('action', 'executeAction');
  logger.info('action', 'dispatching', {
    type: action.action,
    hasElementIndex: 'elementIndex' in action,
    hasFields: 'fields' in action,
    hasPending: 'pendingAction' in action,
  });
  let result: string;
  try {
    switch (action.action) {
      case 'none':
        result = action.speech;
        break;

      case 'navigate':
        result = navigateAction(action.url);
        break;

      case 'click':
        result = clickAction(action.elementIndex, snapshot, action.description);
        break;

      case 'fill':
        result = await fillAction(action.fields, snapshot, action.description);
        break;

      case 'confirm':
        result = confirmAction(action.pendingAction, action.speech);
        break;

      default:
        result = 'Something went wrong executing that action. Try again.';
    }
    sw.stop(action.action);
    return result;
  } catch (e) {
    logger.error('action', 'dispatcher threw', {
      err: e instanceof Error ? e.message : String(e),
    });
    sw.stop('error');
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Confirmation helpers
// ---------------------------------------------------------------------------

/**
 * Check whether the current user transcript is a confirmation response for
 * a pending action. If so, the returned `action` should be executed.
 *
 * Call this at the top of the ACTIVATE handler, BEFORE sending to the LLM.
 *
 * @param transcript - The user's spoken transcript
 * @returns Result indicating whether it's a confirm, if there was a pending
 *          action that was cancelled, and the action to execute (if confirmed)
 */
export function checkConfirmation(
  transcript: string,
): { isConfirm: boolean; hadPending: boolean; action?: DiamondAction } {
  if (!pendingConfirm) {
    return { isConfirm: false, hadPending: false };
  }

  const lower = transcript.toLowerCase().trim();

  if (CONFIRM_PHRASES.has(lower)) {
    const action = pendingConfirm;
    pendingConfirm = null;
    return { isConfirm: true, hadPending: true, action };
  }

  // Not a confirmation — clear pending and signal cancellation
  pendingConfirm = null;
  return { isConfirm: false, hadPending: true };
}

/** True if there is a pending action awaiting confirmation. */
export function hasPendingConfirm(): boolean {
  return pendingConfirm !== null;
}

// ---------------------------------------------------------------------------
// clickAction
// ---------------------------------------------------------------------------

/**
 * Execute a click action: scroll element into view, then click it.
 *
 * @param elementIndex - 1-based index into snapshot.elements
 * @param snapshot     - The page snapshot with elements array
 * @param description  - Human description from the LLM (e.g., "Clicking Add to Cart")
 * @returns Result string to speak
 */
export function clickAction(
  elementIndex: number,
  snapshot: PageSnapshot,
  description: string,
): string {
  const el = resolveElement(elementIndex, snapshot);
  if (!el) {
    logger.warn('action', 'click: element not found', { elementIndex });
    return ERRORS.ELEMENT_NOT_FOUND;
  }

  logger.info('action', 'click', {
    elementIndex,
    tag: el.tagName,
    description,
    role: el.getAttribute('role'),
  });

  el.scrollIntoView?.({ behavior: 'instant', block: 'center' });

  // Try standard .click() first
  try {
    el.click();
  } catch {
    // .click() might throw on some elements — fall through to MouseEvent
  }

  // If the element is still not focused/clicked (e.g., div[role="button"]),
  // dispatch a real MouseEvent with full bubbles/cancelable chain
  if (
    el.tagName !== 'A' &&
    el.tagName !== 'BUTTON' &&
    el.tagName !== 'INPUT'
  ) {
    // For custom role-based elements, ensure a proper click event
    // view: window excluded — the view parameter fails type checks in
    // some jsdom environments and isn't needed for DOM click simulation
    try {
      el.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
        }),
      );
    } catch {
      // MouseEvent may not be available in all environments;
      // the standard .click() call above already handles most cases
    }
  }

  return description;
}

// ---------------------------------------------------------------------------
// navigateAction
// ---------------------------------------------------------------------------

/**
 * Execute a navigation action.
 *
 * Same-origin URLs navigate in-place (location.href).
 * Cross-origin URLs open in a new tab (window.open).
 * javascript: URLs are refused — security risk.
 *
 * @param url - The URL to navigate to
 * @returns Result string to speak
 */
export function navigateAction(url: string): string {
  logger.info('action', 'navigate', { url });
  // Refuse javascript: URLs
  if (url.startsWith('javascript:')) {
    logger.warn('action', 'javascript URL refused', { url });
    return ERRORS.JS_REFUSED;
  }

  // Resolve relative URLs
  const resolved = resolveUrl(url);
  if (!resolved) {
    return ERRORS.NAV_FAILED;
  }

  const currentOrigin = window.location.origin;

  if (resolved.startsWith(currentOrigin)) {
    // Same-origin: navigate in-place
    try {
      window.location.href = resolved;
      return ''; // Navigation will unload the page — no need to speak
    } catch {
      return ERRORS.NAV_FAILED;
    }
  }

  // Cross-origin: open in new tab
  try {
    window.open(resolved, '_blank');
    return ''; // New tab opened — no need to speak (browser handles it)
  } catch {
    return ERRORS.NAV_FAILED;
  }
}

/**
 * Resolve a potentially relative URL against location.origin.
 * Returns null if the URL is invalid.
 */
function resolveUrl(url: string): string | null {
  try {
    if (url.startsWith('/')) {
      return window.location.origin + url;
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    // Maybe it's a relative path without leading slash
    if (!url.includes('://')) {
      return window.location.origin + '/' + url;
    }
    return url;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// fillAction
// ---------------------------------------------------------------------------

/**
 * Execute a fill action: fill form fields with provided values.
 *
 * Uses nativeInputValueSetter for framework detection (React/Vue/Angular).
 * Dispatches input, change, blur events to trigger framework state updates.
 * Detects sensitive fields (password, CC, SSN, etc.) and requires
 * verbal confirmation before filling those.
 *
 * @param fields      - Array of { elementIndex, value } pairs
 * @param snapshot    - PageSnapshot with elements array
 * @param description - Human description from the LLM
 * @returns Result string to speak
 */
export async function fillAction(
  fields: FillField[],
  snapshot: PageSnapshot,
  description: string,
): Promise<string> {
  // ── Phase G: Resolve profile-based fill values (profile: sentinel) ────
  const resolvedFields = await resolveProfileFields(fields);

  // Log the fill plan WITHOUT VALUES — privacy contract.
  // We log only field indices and resolved sensitive-types so debugging is
  // possible without leaking passwords / card numbers.
  logger.info('action', 'fill', {
    fieldCount: resolvedFields.length,
    indices: resolvedFields.map((f) => f.elementIndex),
  });

  // ── Pass 1: validate all elements exist ────────────────────────────────
  for (const field of resolvedFields) {
    const el = resolveElement(field.elementIndex, snapshot);
    if (!el) {
      return ERRORS.ELEMENT_NOT_FOUND;
    }

    // Check writability
    if (!isWritable(el)) {
      return ERRORS.FILL_FAILED;
    }
  }

  // ── Pass 2: detect sensitive fields and require confirmation ────────────
  const sensitiveText = getSensitiveReadback(resolvedFields, snapshot);
  if (sensitiveText) {
    logger.warn('action', 'sensitive field detected — confirmation required', {
      fieldCount: resolvedFields.length,
    });
    // Store the RESOLVED fill action as pending confirmation
    pendingConfirm = {
      action: 'fill',
      fields: resolvedFields,
      description,
    };
    return sensitiveText; // e.g., "Filling your password. Say 'confirm' to proceed."
  }

  // ── Pass 3: execute the fill ───────────────────────────────────────────
  applyFill(resolvedFields, snapshot);

  if (description) return description;
  return `Filled ${fields.length} field${fields.length > 1 ? 's' : ''}.`;
}

/**
 * Apply fill values to form elements.
 * Uses nativeInputValueSetter for React/Vue/Angular compatibility.
 */
function applyFill(fields: FillField[], snapshot: PageSnapshot): void {
  for (const field of fields) {
    const el = resolveElement(field.elementIndex, snapshot);
    if (!el) continue;

    if (el.tagName === 'SELECT') {
      applySelectFill(el as HTMLSelectElement, field.value);
    } else if (
      el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA'
    ) {
      applyInputFill(el as HTMLInputElement | HTMLTextAreaElement, field.value);
    }
  }
}

/**
 * Fill an input or textarea using nativeInputValueSetter for framework
 * compatibility, then dispatch input/change/blur events.
 */
function applyInputFill(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const proto =
    element.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;

  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (nativeSetter) {
    nativeSetter.call(element, value);
  } else {
    // Fallback: direct assignment
    element.value = value;
  }

  // Dispatch events so framework state updates detect the change
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.dispatchEvent(new Event('blur', { bubbles: true }));
}

/**
 * Select an option in a <select> element matching the given text.
 */
function applySelectFill(element: HTMLSelectElement, value: string): void {
  const lowerValue = value.toLowerCase();
  const option = Array.from(element.options).find(
    (o) =>
      o.text.toLowerCase().includes(lowerValue) ||
      o.value.toLowerCase() === lowerValue ||
      o.label.toLowerCase().includes(lowerValue),
  );

  if (option) {
    element.value = option.value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    // Option not found — set as value anyway
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

// ---------------------------------------------------------------------------
// selectOption — public helper for <select> matching
// ---------------------------------------------------------------------------

/**
 * Select the option in a <select> by matching text (case-insensitive).
 * If no match is found, returns a descriptive error string.
 *
 * @param element    - The <select> element
 * @param optionText - The text or value to match against options
 * @returns Empty string on success, or an error message on failure
 */
export function selectOption(
  element: HTMLSelectElement,
  optionText: string,
): string {
  const lowerText = optionText.toLowerCase();
  const option = Array.from(element.options).find(
    (o) =>
      o.text.toLowerCase().includes(lowerText) ||
      o.value.toLowerCase() === lowerText ||
      o.label.toLowerCase().includes(lowerText),
  );

  if (!option) {
    return `I couldn't find an option matching '${optionText}' in that dropdown.`;
  }

  element.value = option.value;
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return '';
}

// ---------------------------------------------------------------------------
// Sensitive field detection
// ---------------------------------------------------------------------------

/** Types of sensitive fields we recognize. */
type SensitiveType = 'password' | 'credit-card' | 'ssn' | 'dob' | 'cvv';

/** Pattern sets for detecting sensitive fields by attribute values. */
const SENSITIVE_KEYWORDS: Record<SensitiveType, string[]> = {
  password: ['password', 'passwd', 'pwd'],
  'credit-card': ['cc', 'cardnumber', 'card-number', 'card_number', 'creditcard', 'credit-card', 'credit_card'],
  ssn: ['ssn', 'socialsecurity', 'social-security'],
  dob: ['dob', 'date-of-birth', 'date_of_birth', 'birthdate', 'birth-date'],
  cvv: ['cvv', 'cvc', 'security-code', 'securitycode'],
};

/**
 * Determine if an element is a sensitive field and what type.
 *
 * Checks: type attribute, name, id, placeholder, aria-label, and
 * associated label text.
 *
 * @param el - The HTMLElement to check
 * @returns The sensitive type detected, or null if not sensitive
 */
export function detectSensitiveType(el: HTMLElement): SensitiveType | null {
  // type="password" is unambiguous
  if (
    el.tagName === 'INPUT' &&
    (el as HTMLInputElement).type?.toLowerCase() === 'password'
  ) {
    return 'password';
  }

  // Check name, id, placeholder, aria-label, and label text
  const checkValues = [
    (el as HTMLInputElement).name,
    el.id,
    (el as HTMLInputElement).placeholder,
    el.getAttribute('aria-label'),
    getLabelText(el),
  ]
    .filter(Boolean)
    .map((s) => (s as string).toLowerCase());

  for (const [type, keywords] of Object.entries(SENSITIVE_KEYWORDS) as [SensitiveType, string[]][]) {
    for (const value of checkValues) {
      for (const kw of keywords) {
        // Normalize both value and keyword: replace hyphens with spaces
        // so "date-of-birth" matches "date of birth" (aria-label) and vice versa
        const normalizedValue = value.replace(/-/g, ' ');
        const normalizedKw = kw.replace(/-/g, ' ');
        if (normalizedValue.includes(normalizedKw)) return type;
      }
    }
  }

  return null;
}

/**
 * Get the text content of a <label> associated with the given element,
 * either via <label for="id"> or wrapping <label>.
 */
function getLabelText(el: HTMLElement): string | null {
  if (!el.isConnected) return null;

  if ('labels' in el) {
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length > 0) {
      return labels[0].textContent ?? null;
    }
  }

  return null;
}

/**
 * Check whether an element is writable (not disabled, not readOnly,
 * and an instanceof HTMLInputElement / HTMLTextAreaElement / HTMLSelectElement).
 *
 * Guard rule: an HTMLDivElement, HTMLSpanElement, or any general
 * HTMLElement is NEVER writable. We only fill actual form controls.
 * This means the cast/lookup for `disabled` / `readOnly` is type-safe
 * because we've already narrowed to input/textarea/select.
 */
function isWritable(el: HTMLElement): boolean {
  if (
    !(el instanceof HTMLInputElement) &&
    !(el instanceof HTMLTextAreaElement) &&
    !(el instanceof HTMLSelectElement)
  ) {
    return false;
  }
  if (el.disabled) return false;
  // readOnly only applies to input/textarea, not select — single check.
  if ('readOnly' in el && el.readOnly) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Sensitive field read-back (masked)
// ---------------------------------------------------------------------------

/**
 * Build a masked read-back string for sensitive fields.
 * Returns null if no fields are sensitive (fill can proceed immediately).
 *
 * @param fields   - The fill fields from the action
 * @param snapshot - PageSnapshot for element resolution
 * @returns A spoken prompt requiring confirmation, or null
 */
function getSensitiveReadback(
  fields: FillField[],
  snapshot: PageSnapshot,
): string | null {
  const prompts: string[] = [];

  for (const field of fields) {
    const el = resolveElement(field.elementIndex, snapshot);
    if (!el) continue;

    const sensitiveType = detectSensitiveType(el);
    if (!sensitiveType) continue;

    const value = field.value;
    const last4 = value.length >= 4 ? value.slice(-4) : value;

    switch (sensitiveType) {
      case 'password':
        prompts.push(ERRORS.SENSITIVE_CONFIRM('password'));
        break;
      case 'credit-card':
        prompts.push(ERRORS.SENSITIVE_CC_CONFIRM(last4));
        break;
      case 'ssn':
        prompts.push(ERRORS.SENSITIVE_SSN_CONFIRM(last4));
        break;
      case 'cvv':
        prompts.push(ERRORS.SENSITIVE_CONFIRM('security code'));
        break;
      case 'dob':
        prompts.push(ERRORS.SENSITIVE_CONFIRM(`date of birth ${value}`));
        break;
    }
  }

  if (prompts.length === 0) return null;

  // Deduplicate similar prompts and join
  // Each prompt already includes "Say 'confirm' to proceed." from ERRORS constants
  const unique = [...new Set(prompts)];
  return unique.join(' ');
}

// ---------------------------------------------------------------------------
// confirmAction
// ---------------------------------------------------------------------------

/**
 * Handle a confirm action from the LLM.
 *
 * Stores the pending action for later execution when the user says
 * "confirm" / "yes" / etc. on the next ACTIVATE cycle.
 *
 * @param pending  - The actual action to execute on confirmation
 * @param speech   - The confirmation prompt to speak (e.g., "This will submit your order. Say 'confirm' to proceed.")
 * @returns The speech to speak immediately (the prompt)
 */
export function confirmAction(
  pending: DiamondAction,
  speech: string,
): string {
  pendingConfirm = pending;
  return speech;
}

// ---------------------------------------------------------------------------
// Profile-based fill resolution
// ---------------------------------------------------------------------------

/** Prefix for profile-based fill values. */
const PROFILE_PREFIX = 'profile:';

/**
 * Resolve profile-based fill values when the LLM returns
 * `"value": "profile:<field>"` sentinels.
 *
 * The LLM never sees the actual profile values — only labels.
 * Resolution happens client-side via chrome.storage.local.
 *
 * Supported patterns:
 *   profile:email          → UserProfile.email
 *   profile:phone          → UserProfile.phone
 *   profile:address:Home   → SavedAddress where label === "Home", lines joined
 *   profile:link:GitHub    → SavedLink where label === "GitHub", URL
 *
 * @param fields - The original fill fields from the LLM
 * @returns Resolved fields (unchanged if no profile: prefixes)
 */
async function resolveProfileFields(fields: FillField[]): Promise<FillField[]> {
  const hasProfile = fields.some((f) =>
    typeof f.value === 'string' && f.value.startsWith(PROFILE_PREFIX),
  );

  if (!hasProfile) return fields;

  // Try to load the profile from chrome.storage.local
  let profile: {
    savedAddresses?: Array<{ label: string; lines: string[] }>;
    savedLinks?: Array<{ label: string; url: string }>;
    email?: string;
    phone?: string;
  } = {};

  try {
    // Chrome is available in content script context
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const result = await chrome.storage.local.get('diamond_profile');
      profile = (result.diamond_profile as typeof profile) ?? {};
    }
  } catch {
    // chrome.storage unavailable — return original fields (LLM values passed through)
    return fields;
  }

  return fields.map((f) => {
    if (typeof f.value !== 'string' || !f.value.startsWith(PROFILE_PREFIX)) {
      return f;
    }

    const parts = f.value.slice(PROFILE_PREFIX.length).split(':');
    const field = parts[0]?.toLowerCase();
    const label = parts.slice(1).join(':'); // rest is the label

    switch (field) {
      case 'email':
        return { ...f, value: profile.email ?? f.value };
      case 'phone':
        return { ...f, value: profile.phone ?? f.value };
      case 'address':
        if (label && profile.savedAddresses) {
          const addr = profile.savedAddresses.find(
            (a: { label: string }) => a.label.toLowerCase() === label.toLowerCase(),
          );
          if (addr) {
            return { ...f, value: addr.lines.join(', ') };
          }
        }
        return f;
      case 'link':
        if (label && profile.savedLinks) {
          const link = profile.savedLinks.find(
            (l: { label: string }) => l.label.toLowerCase() === label.toLowerCase(),
          );
          if (link) {
            return { ...f, value: link.url };
          }
        }
        return f;
      default:
        return f;
    }
  });
}

// ---------------------------------------------------------------------------
// Element resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a 1-based elementIndex to an actual HTMLElement.
 *
 * @param elementIndex - 1-based index (as returned by LLM)
 * @param snapshot     - The page snapshot
 * @returns The HTMLElement, or null if out of bounds
 */
function resolveElement(
  elementIndex: number,
  snapshot: PageSnapshot,
): HTMLElement | null {
  const idx = elementIndex - 1;
  if (idx < 0 || idx >= snapshot.elements.length) return null;
  return snapshot.elements[idx] ?? null;
}
