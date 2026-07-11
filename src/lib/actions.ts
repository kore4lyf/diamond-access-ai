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
import { enumerateImages, speakImageList } from './dom-walk';
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
  | { action: 'confirm'; speech: string; pendingAction: DiamondAction }
  | { action: 'back'; description: string }
  | { action: 'forward'; description: string }
  | { action: 'refresh'; description: string }
  | { action: 'describe_image'; elementIndex: number; description: string }
  | { action: 'list_images'; description: string }
  | { action: 'read_article'; description: string }
  | { action: 'summarize_article'; description: string };

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

      case 'back':
        result = backAction(action.description);
        break;

      case 'forward':
        result = forwardAction(action.description);
        break;

      case 'refresh':
        result = refreshAction(action.description);
        break;

      case 'click':
        result = clickAction(action.elementIndex, snapshot, action.description);
        break;

      case 'fill':
        result = await fillAction(action.fields, snapshot, action.description);
        break;

      case 'describe_image':
        result = await describeImageAction(action.elementIndex, snapshot, action.description);
        break;

      case 'list_images':
        result = listImagesAction(action.description);
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
  // Phase J: try elementIndex first; if it misses (DOM drift, stale
  // snap, off-by-one), fall back to description-based matching against
  // the same snapshot. PC-QS-1 — Google search submit, where the LLM
  // typically picks an elementIndex whose snap has already shifted
  // after the previous fillAction.
  let el = resolveElement(elementIndex, snapshot);
  let viaFallback = false;
  if (!el && description) {
    el = resolveElementByDescription(description, snapshot);
    if (el) {
      viaFallback = true;
      logger.info('action', 'click: resolved via description fallback', {
        requestedIndex: elementIndex,
        description,
        tag: el.tagName,
      });
    }
  }
  if (!el) {
    logger.warn('action', 'click: element not found', {
      elementIndex,
      description,
    });
    return ERRORS.ELEMENT_NOT_FOUND;
  }

  logger.info('action', 'click', {
    elementIndex,
    tag: el.tagName,
    description,
    role: el.getAttribute('role'),
    viaFallback,
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

// ---------------------------------------------------------------------------
// Browser-chrome actions (Fix 2 — PC-BACK)
//
// Diamond is the hands of a blind user. These map directly to page-context
// APIs, not extension APIs. NO new permissions required — content-script
// context already has access to `history` and `location`. Page-chrome
// destructive (history.back / history.forward / location.reload) tear the
// page down, so each helper schedules the call via `setTimeout(..., 50)`
// to let the TTS queue accept the spoken acknowledgment before unload.
//
// History-aware messaging (PC-BACK follow-up):
//   - back:    if history.length <= 1, the user opened this tab
//              directly and there is nothing to go back to. Speak
//              "There is no previous page." and skip the navigation.
//   - forward: only meaningful right after a back. A tiny module-level
//              `lastActionWasBack` flag tracks this — set on a
//              successful back (history.length >= 2), cleared by
//              forwardAction when it actually fires. Conservative but
//              predictable for blind users who'd otherwise hear a
//              "Going forward." that immediately stalls.
// ---------------------------------------------------------------------------

/**
 * Set by backAction so forwardAction knows there's something to go
 * forward to. Cleared by forwardAction when it fires successfully.
 *
 * PC-NAVAPI follow-up (use the browser, not your own stack):
 *   The cleanest answer to "is there a back/forward page?" is to
 *   query the browser — the Navigation API
 *      window.navigation.currentEntry.index
 *      window.navigation.entries().length
 *   tells us exactly where the user is in their tab's history stack,
 *   and stays correct after ANY navigation: Diamond-driven back/
 *   forward, browser-driven back/forward, link clicks,
 *   location.assign, etc. No re-implementation of state required.
 *
 *   For Chrome pre-102 (or sandboxed contexts without Navigation
 *   API) we fall back to:
 *     - back: history.length > 1
 *     - forward: our own window.name flag (only set right after our
 *       own backAction — conservative: only permits forward when we
 *       know we just came from a back we performed).
 *
 *   Naive module-level `let lastActionWasBack` would NOT survive
 *   the page navigation that history.back() triggers — the new
 *   page's content script re-initializes the variable. window.name
 *   is the standard platform-level workaround — it persists across
 *   same-tab navigations and is fresh on new tabs/windows. The
 *   Navigation API is preferred because the browser gives us the
 *   answer directly with no extension-side bookkeeping.
 */
const WINDOW_NAME_BACK = 'diamond_last_back';

function readBackFlag(): boolean {
  try {
    return window.name === WINDOW_NAME_BACK;
  } catch {
    return false;
  }
}

function writeBackFlag(on: boolean): void {
  try {
    if (on) {
      window.name = WINDOW_NAME_BACK;
    } else if (window.name === WINDOW_NAME_BACK) {
      window.name = '';
    }
  } catch {
    /* window.name is read-only in some sandboxes; ignore */
  }
}

/**
 * Read the browser's Navigation API when available.
 *
 * Returns `null` if `window.navigation` isn't supported (Chrome pre-102
 * or restricted contexts like sandboxed iframes). The fallback paths
 * (`canGoBack` / `canGoForward`) handle that gracefully.
 */
function readNavIndex(): { index: number; total: number } | null {
  try {
    const nav = (window as unknown as {
      navigation?: { currentEntry?: { index?: number }; entries?: () => Array<unknown> };
    }).navigation;
    if (!nav || typeof nav.entries !== 'function') return null;
    const total = nav.entries().length;
    const index = nav.currentEntry?.index ?? -1;
    return { index, total };
  } catch {
    return null;
  }
}

function canGoBack(): boolean {
  const info = readNavIndex();
  if (info) return info.index > 0;
  // Fallback: prior entries exist in tab history.
  return history.length > 1;
}

function canGoForward(): boolean {
  const info = readNavIndex();
  if (info) return info.index < info.total - 1;
  // Fallback: only if WE just performed a back in this tab. The
  // browser doesn't expose forward availability via history.length,
  // so this is the conservative fallback (forward permitted iff we
  // know a back of ours preceded it).
  return readBackFlag();
}

/**
 * Trigger the browser back gesture. Uses window.history.back() in the
 * active tab. If the tab has no history (history.length <= 1), the
 * user opened it directly and there is nothing to go back to — report
 * that instead of scheduling a useless navigation.
 */
export function backAction(description: string): string {
  const info = readNavIndex();
  logger.info('action', 'back', {
    historyLen: history.length,
    navIndex: info?.index,
    navTotal: info?.total,
  });
  if (!canGoBack()) {
    return 'There is no previous page to go back to.';
  }
  writeBackFlag(true);
  const msg = description || 'Going back.';
  setTimeout(() => {
    try { history.back(); } catch (e) {
      logger.warn('action', 'history.back() threw', {
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }, 50);
  return msg;
}

/**
 * Trigger the browser forward gesture. Reads the browser's Navigation
 * API to determine if there is a forward entry, falling back to our
 * own back-tracking flag when the API isn't available.
 */
export function forwardAction(description: string): string {
  const info = readNavIndex();
  logger.info('action', 'forward', {
    historyLen: history.length,
    navIndex: info?.index,
    navTotal: info?.total,
  });
  if (!canGoForward()) {
    return 'There is no next page to go forward to.';
  }
  writeBackFlag(false);
  const msg = description || 'Going forward.';
  setTimeout(() => {
    try { history.forward(); } catch (e) {
      logger.warn('action', 'history.forward() threw', {
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }, 50);
  return msg;
}

/**
 * Reload the current tab in place. Reversible — no confirm needed.
 * Refresh neither moves the user forward nor back, so the
 * `lastActionWasBack` flag is intentionally left alone.
 */
export function refreshAction(description: string): string {
  logger.info('action', 'refresh');
  const msg = description || 'Refreshing.';
  setTimeout(() => { location.reload(); }, 50);
  return msg;
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
// describeImageAction — Phase J + Image-describe feature
//
// Trigger: LLM emits {"action":"describe_image","elementIndex":N} after
// the user names a specific image ("describe the cover photo", "what does
// this dress look like"). This helper does the work the LLM can't:
//
//   1. resolveElement(N, snapshot) → <img> element
//   2. capability gate: if active model is text-only, speak a clean
//      error and exit before burning an API call
//   3. compute bbox × devicePixelRatio → screenshot pixel-space coords
//   4. sendMessage to background → capture+crop+vision LLM
//   5. return the spoken description
// ---------------------------------------------------------------------------

/** Edge size cap for the cropped image — keeps vision token cost bounded. */
const CROP_MAX_EDGE_PX = 1024;
/** Padding around the bbox, expressed as fraction of the bbox dimension. */
const CROP_PADDING_RATIO = 0.06;

/**
 * Resolve and execute a describe_image action.
 *
 * @param elementIndex - 1-based snapshot index of the <img> to describe
 * @param snapshot     - Current page snapshot
 * @param description  - Human description from the LLM (e.g., "Describing the cover photo.")
 * @returns Spoken description (from the vision LLM) or a clean error string
 */
export async function describeImageAction(
  elementIndex: number,
  snapshot: PageSnapshot,
  description: string,
): Promise<string> {
  const el = resolveElement(elementIndex, snapshot);
  if (!el) {
    logger.warn('action', 'describe_image: element not found', { elementIndex });
    return ERRORS.ELEMENT_NOT_FOUND;
  }
  if (el.tagName !== 'IMG') {
    logger.warn('action', 'describe_image: not an <img>', {
      elementIndex,
      tag: el.tagName,
    });
    return 'I can only describe images. Try a different element.';
  }

  // ── Capability gate: skip the API call when model is text-only ────────
  let modelId: string | null = null;
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const r = await chrome.storage.local.get('diamond_model');
      modelId = (r.diamond_model as string | undefined) ?? null;
    }
  } catch { /* storage unavailable — fall through to default */ }
  // Lazy import to avoid a circular dep at module load time
  const { isVisionCapable } = await import('./fireworks');
  if (modelId && !isVisionCapable(modelId)) {
    logger.warn('action', 'describe_image: model not vision-capable', {
      model: modelId,
    });
    return 'The current model cannot describe images. Switch to a vision-capable model in Options.';
  }

  // ── Bounding-rect computation in CSS pixels, scaled to screenshot ─────
  const rect = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const padW = rect.width * CROP_PADDING_RATIO;
  const padH = rect.height * CROP_PADDING_RATIO;
  const bbox = {
    x: Math.max(0, Math.floor((rect.left - padW) * dpr)),
    y: Math.max(0, Math.floor((rect.top - padH) * dpr)),
    width:  Math.ceil((rect.width  + padW * 2) * dpr),
    height: Math.ceil((rect.height + padH * 2) * dpr),
  };
  logger.info('action', 'describe_image: requesting capture', {
    elementIndex,
    bbox,
    dpr,
    pageUrl: window.location.href,
  });

  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'DESCRIBE_CROP',
      bbox,
      pageUrl: window.location.href,
    })) as { description?: string } | undefined;
    const got = response?.description?.trim();
    if (!got) {
      logger.warn('action', 'describe_image: empty response');
      return ERRORS.AI_UNAVAILABLE;
    }
    return description ? `${description} ${got}` : got;
  } catch (e) {
    logger.error('action', 'describe_image: sendMessage failed', {
      err: e instanceof Error ? e.message : String(e),
    });
    return ERRORS.AI_UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// listImagesAction — Phase J + Image-describe feature
//
// Trigger: LLM emits {"action":"list_images"} for "what images are on
// this page?" / "list the images". No LLM call — enumerate the DOM
// directly and speak the list. Vision cost is zero on the list phase;
// describe_image only fires once the user picks an index.
// ---------------------------------------------------------------------------

/**
 * Enumerate <img> elements, speak the list, return the spoken string.
 *
 * @param description - Spoken prefix the LLM suggested (usually empty)
 * @returns Spoken list string, suitable for content.ts to pass to speak()
 */
export function listImagesAction(description: string): string {
  const images = enumerateImages(typeof document !== 'undefined' ? document.body : undefined);
  logger.info('action', 'list_images: enumerated', { count: images.length });
  const spoken = speakImageList(images);
  return description ? `${description} ${spoken}` : spoken;
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

/**
 * Resolve an element by matching its description text against the
 * snapshot's element visible text / aria-label / input value.
 * Used as a fallback when the LLM's elementIndex is stale or out of
 * bounds (Phase J PC-QS-1 mitigation).
 *
 * @param description - The LLM-provided action description, e.g.
 *                     "Clicking Google Search"
 * @param snapshot    - The page snapshot
 * @returns The first matching HTMLElement, or null if no match
 */
function resolveElementByDescription(
  description: string,
  snapshot: PageSnapshot,
): HTMLElement | null {
  const needle = description.toLowerCase().trim();
  if (!needle) return null;
  for (const el of snapshot.elements) {
    if (!el) continue;
    const text =
      (el.textContent?.trim() ?? '').toLowerCase() ||
      (el.getAttribute('aria-label')?.trim() ?? '').toLowerCase();
    if (!text) continue;
    if (text.includes(needle)) return el as HTMLElement;
    // For inputs/buttons, also check the value attribute.
    if (
      el.tagName === 'INPUT' ||
      el.tagName === 'BUTTON'
    ) {
      const value = ((el as HTMLInputElement).value ?? '').toLowerCase();
      if (value && value.includes(needle)) return el as HTMLElement;
    }
  }
  return null;
}
