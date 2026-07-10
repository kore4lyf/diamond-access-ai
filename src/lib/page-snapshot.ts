/**
 * Diamond Access AI — Page Snapshot
 *
 * Phase E: Bridges the gap between the DOM walk (string output) and
 * the action schemas (elementIndex references). Produces both a
 * numbered structure string for the LLM and a parallel array of
 * interactive HTMLElements the content script can act on.
 *
 * Architecture:
 *   buildPageSnapshot(root?)  — wraps extractPageStructureFromRoot
 *                                and returns { structure, elements }
 *
 * The structure lines for interactive elements get [N] prefixes
 * (1-based) so the LLM can reference them by index. The elements[]
 * array is 0-based; elementIndex N in JSON → elements[N-1].
 *
 * This keeps dom-walk.ts untouched (Phase B tests stay green).
 * The walk logic for element collection is replicated internally
 * to guarantee consistent traversal order.
 *
 * IMPLEMENTED IMAGE INDEXING (PC-QA-PC-X-IMG-PR):
 *   IMG elements with meaningful alt text get elementIndex now.
 *   Earlier: IMG was filtered out, so the LLM could not reference
 *   cover photos, hero images, or product images by index, and
 *   describe_image fired zero times on news/retail pages that
 *   carry real captions.
 *   Now: an <img> with non-empty alt is interactive for indexing
 *   purposes only. We do not click or hover it — only describe it.
 */

import { extractPageStructureFromRoot } from './dom-walk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PageSnapshot {
  /** Numbered page structure text (interactive elements get [N] prefix). */
  structure: string;
  /** Parallel array of interactive HTMLElements indexed by [N]. */
  elements: HTMLElement[];
}

// ---------------------------------------------------------------------------
// Skip logic (mirrors dom-walk.ts for consistent traversal order)
// ---------------------------------------------------------------------------

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'MATH',
  'META', 'LINK', 'HEAD', 'TEMPLATE',
  'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO',
]);

const SKIP_LINE_SELECTOR = '[aria-hidden="true"], [hidden], [inert]';

function shouldSkipElement(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName)) return true;

  try {
    if (el.matches(SKIP_LINE_SELECTOR)) return true;
  } catch {
    // Gracefully handle invalid selectors
  }

  // IMG: previously skipped unless alt was present. Now: include if
  // non-empty alt — interactive elements[] needs <img> for describe_image
  // to fire (PC-X-IMG-PR). Decorative images (alt="" or missing) stay
  // skipped so list_images() doesn't pull trash.
  if (el.tagName === 'IMG') {
    const alt = el.getAttribute('alt');
    return alt === null || alt === undefined || alt.trim() === '';
  }

  // Skip <br>, <wbr>, <hr> — no semantic value
  if (el.tagName === 'BR' || el.tagName === 'WBR' || el.tagName === 'HR') return true;

  return false;
}

// ---------------------------------------------------------------------------
// Role mapping (mirrors dom-walk.ts for consistent order)
// ---------------------------------------------------------------------------

const IMPLICIT_ROLES: Record<string, string | ((el: Element) => string | null)> = {
  A: (el: Element) => ((el as HTMLAnchorElement).href ? 'link' : null),
  BUTTON: 'button',
  IMG: 'img',  // PC-X-IMG-PR: image role so <img> with alt gets elementIndex
  INPUT: (el: Element) => {
    const type = (el as HTMLInputElement).type?.toLowerCase() ?? 'text';
    const map: Record<string, string> = {
      text: 'textbox', email: 'textbox', password: 'textbox',
      search: 'searchbox', tel: 'textbox', url: 'textbox',
      checkbox: 'checkbox', radio: 'radio',
      submit: 'button', reset: 'button', button: 'button',
      range: 'slider', number: 'spinbutton',
      file: 'button', image: 'button',
    };
    return map[type] ?? 'textbox';
  },
  SELECT: 'listbox',
  TEXTAREA: 'textbox',
};

function getRoleDisplay(el: Element): string {
  const tag = el.tagName;

  // Heading level
  if (tag === 'H1' || tag === 'H2' || tag === 'H3' ||
      tag === 'H4' || tag === 'H5' || tag === 'H6') {
    return `heading level=${tag[1]}`;
  }

  // Explicit role attribute
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;

  // Implicit role from tag mapping
  const implicit = IMPLICIT_ROLES[tag];
  if (implicit === undefined) return '';
  if (typeof implicit === 'function') return implicit(el) ?? '';
  return implicit;
}

// ---------------------------------------------------------------------------
// Interactive element detection
// ---------------------------------------------------------------------------

/** Tags that are inherently interactive. */
const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

/** Roles that represent actionable elements. */
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio',
  'slider', 'spinbutton', 'listbox', 'combobox', 'menuitem', 'tab', 'switch',
]);

function isInteractive(el: Element, roleDisplay: string): boolean {
  // Tag-based: all listed tags are interactive (A requires href, IMG
  // requires meaningful alt — which is gated by shouldSkipElement
  // upstream too, so we don't double-skip alt-less <img> here).
  if (INTERACTIVE_TAGS.has(el.tagName)) {
    if (el.tagName === 'A') {
      const href = (el as HTMLAnchorElement).href;
      return href !== undefined && href !== '';
    }
    return true;
  }

  // IMG: PC-X-IMG-PR. Page-snapshot now indexes <img> elements with
  // non-empty alt so describe_image has elementIndex to fire on. <img>
  // isn't traditionally "interactive" (we don't click it) but the LLM
  // needs an index to act on it. Cross-checked upstream in
  // shouldSkipElement so alt-less images never reach this branch.
  if (el.tagName === 'IMG') {
    const alt = el.getAttribute('alt');
    return !!alt && alt.trim().length > 0;
  }

  // Role-based (for div[role="button"], etc.)
  const role = roleDisplay.split(' ')[0];
  return INTERACTIVE_ROLES.has(role);
}

/**
 * Walk the DOM tree depth-first, collecting interactive elements
 * in the same order as dom-walk.ts's processElement.
 */
function collectInteractiveElements(root: Element): HTMLElement[] {
  const elements: HTMLElement[] = [];

  function walk(el: Element): void {
    if (shouldSkipElement(el)) return;

    const roleDisplay = getRoleDisplay(el);
    const hasRole = roleDisplay !== '';

    // Only collect elements that have a semantic role AND are interactive
    if (hasRole && isInteractive(el, roleDisplay)) {
      elements.push(el as HTMLElement);
    }

    // Walk children — same depth-first order as dom-walk
    for (let i = 0; i < el.childNodes.length; i++) {
      const child = el.childNodes[i];
      if (child.nodeType === Node.ELEMENT_NODE) {
        walk(child as Element);
      }
    }
  }

  walk(root);
  return elements;
}

// ---------------------------------------------------------------------------
// Line-based interactive detection for post-processing
// ---------------------------------------------------------------------------

/**
 * Regex that matches an interactive role in a structure text line.
 * Lines are from extractPageStructureFromRoot output like:
 *   [button] "Add to cart" → target
 *   [link] "Home"
 *   [textbox] "Search" | value=""
 *   [img] "Cover photo"     ← PC-X-IMG-PR: image lines get indexed now
 *
 * 'img' is here despite not being classically interactive because
 * describe_image needs elementIndex to fire on a specific <img>.
 */
const INTERACTIVE_LINE_RE = /^\s*\[(button|link|textbox|searchbox|checkbox|radio|slider|spinbutton|listbox|combobox|menuitem|tab|switch|img)\]/;

function isInteractiveLine(line: string): boolean {
  return INTERACTIVE_LINE_RE.test(line);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a page snapshot: numbered structure text + parallel element array.
 *
 * The structure text includes [N] prefixes on interactive element lines
 * (1-based indexing). The elements array is 0-based, so elementIndex N
 * in an LLM action JSON resolves to elements[N - 1].
 *
 * @param root - Root element (default: document.body)
 * @returns PageSnapshot with structure and elements array
 */
export function buildPageSnapshot(root: HTMLElement = document.body): PageSnapshot {
  // Get the full structure text from dom-walk (unchanged)
  const structure = extractPageStructureFromRoot(root);

  // Collect interactive elements in the same traversal order
  const elements = collectInteractiveElements(root);

  // Post-process: add [N] prefixes to interactive lines
  const lines = structure.split('\n');
  let counter = 0;
  const taggedLines = lines.map((line) => {
    if (isInteractiveLine(line)) {
      counter++;
      return `[${counter}] ${line}`;
    }
    return line;
  });

  return {
    structure: taggedLines.join('\n'),
    elements,
  };
}

/**
 * Check whether the page DOM is sparse enough to warrant a VLM fallback.
 *
 * Thresholds (heuristic — tune for demo pages):
 *   - Fewer than 3 interactive elements
 *   - Structure text shorter than 200 characters
 *   - More than 80% of non-empty, non-indented lines are "text" role
 *
 * @param root - Root element (default: document.body)
 * @returns True if the DOM appears sparse
 */
export function isSparseDOM(root: HTMLElement = document.body): boolean {
  const snap = buildPageSnapshot(root);

  // Threshold 1: too few interactive elements
  if (snap.elements.length < 3) return true;

  // Threshold 2: structure too short
  if (snap.structure.length < 200) return true;

  // Threshold 3: mostly text roles (no semantic structure)
  const lines = snap.structure.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return true;

  let textLines = 0;
  for (const line of lines) {
    // Lines without a [role] are text content
    if (!line.includes('[')) {
      textLines++;
    }
  }
  if (textLines / lines.length > 0.8) return true;

  return false;
}
