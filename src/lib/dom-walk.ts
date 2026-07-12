/**
 * Diamond Access AI — DOM Walk Engine
 *
 * Phase B: Turns the live page into a compact text tree the LLM reasons over.
 * AI is invoked per *action*, not per *element*, so this tree must be cheap
 * to build and send.
 *
 * Architecture:
 *   extractPageStructure()     — thin wrapper over document.body
 *   extractPageStructureFromRoot(root, maxChars?) — pure function, jsdom-testable
 *
 * Output format (§3.1 of DOC-PAGE-MODEL):
 *   [indent][role] "[name]" [value] [states] [target]
 *
 * Truncation (§3.4 / TO-DEV §2):
 *   Configurable max chars (default 1500). Keeps first 3 depth levels fully,
 *   summarizes deeper elements.
 *
 * Guarantees:
 *   - Read-only (no DOM mutation)
 *   - Deterministic (same DOM → same string)
 *   - No network / Chrome API calls inside FromRoot
 *   - Returns '' for empty body
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Elements whose children are not walked and whose content is never relevant. */
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'MATH',
  'META', 'LINK', 'HEAD', 'TEMPLATE',
  'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO',
]);

/** CSS selector for elements that should be skipped. */
const SKIP_SELECTOR = '[aria-hidden="true"], [hidden], [inert]';

/**
 * Map from HTML tag name to implicit ARIA role.
 * Functions receive the element so they can branch on type/attributes.
 */
const IMPLICIT_ROLES: Record<string, string | ((el: Element) => string | null)> = {
  'A':          (el: Element) => (el as HTMLAnchorElement).href ? 'link' : null,
  'BUTTON':     'button',
  'IMG':        'img',
  'INPUT':      (el: Element) => {
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
  'SELECT':     'listbox',
  'TEXTAREA':   'textbox',
  'NAV':        'navigation',
  'MAIN':       'main',
  'HEADER':     'banner',
  'FOOTER':     'contentinfo',
  'ASIDE':      'complementary',
  'SECTION':    'region',
  'FORM':       'form',
  'TABLE':      'table',
  'UL':         'list',
  'OL':         'list',
  'LI':         'listitem',
  'H1':         'heading',
  'H2':         'heading',
  'H3':         'heading',
  'H4':         'heading',
  'H5':         'heading',
  'H6':         'heading',
};

/**
 * Default maximum output length in characters.
 *
 * PC-QA Round 3 — BBC News homepage regression: at 1500 chars,
 * `truncateLines` summarises depth ≥ 3 content into count summaries
 * like `… 8 more children (article)`. That collapsed every hero
 * `<h2>` headline into a count while leaving the shallower "More to
 * explore" `<ul><li><a>` flat-link pattern intact, so the LLM picked
 * the "More to explore" headlines instead of the actual top of the
 * page. Bumping to 4000 chars fits BBC's full structure (≈5–7k
 * uncompressed) at ~70% without summarising the article list.
 * Token cost: ~1000 input tokens vs ~375 previously — well under
 * Fireworks' 8k context. Small pages are unaffected.
 */
const DEFAULT_MAX_CHARS = 4000;

/** Truncation depth threshold — keep these levels fully. */
const KEEP_DEPTH = 3;

/**
 * Hard cap for text-node capture (chars). Bounds the LLM prompt so a
 * single hostile page (e.g. a giant data-uri-style text node) cannot
 * push the structure string past DEFAULT_MAX_CHARS all by itself.
 */
const MAX_TEXT_NODE_LENGTH = 500;

/**
 * Hard cap for captured element values (chars). Push-down form-fill
 * confirmation flows pass `input.value`, so truncating here means the
 * snapshot can't accidentally leak a 50KB buffer of pasted content
 * through to the LLM.
 */
const MAX_VALUE_LENGTH = 500;

/**
 * Hard cap for accessible-name text (chars). Was 100, bumped to 200
 * to keep long-but-meaningful button labels intact while still
 * bounding growth.
 */
const MAX_ACCESSIBLE_NAME_LENGTH = 200;

/** Hard cap for href / action URLs captured (chars). */
const MAX_ATTRIBUTE_LENGTH = 2000;

/**
 * Hard cap on the number of ELEMENT_NODEs visited by the walker. A
 * 10k-node SPA is realistic (e-commerce listings, news homepages);
 * 50k is generous. Beyond this, the walker returns what it has so far.
 */
const MAX_NODES_VISITED = 50_000;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface LineEntry {
  text: string;
  depth: number;
  role: string;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/** Check whether an element should be excluded from the tree. */
function shouldSkipElement(el: Element): boolean {
  const tag = el.tagName;
  if (SKIP_TAGS.has(tag)) return true;

  try {
    if (el.matches(SKIP_SELECTOR)) return true;
  } catch {
    // Gracefully handle invalid selectors in some environments
  }

  // IMG: only include if it has non-empty alt text
  if (tag === 'IMG') {
    const alt = el.getAttribute('alt');
    // Skip if no alt attribute, or alt is null/undefined, or alt is empty string
    return alt === null || alt === undefined || alt.trim() === '';
  }

  // Skip <br> (line break — no semantic value)
  if (tag === 'BR') return true;

  // Skip <wbr> (word break opportunity)
  if (tag === 'WBR') return true;

  // Skip <hr> (thematic break — not actionable)
  if (tag === 'HR') return true;

  return false;
}

/** Get the heading level (1-6) or 0 if not a heading. */
function getHeadingLevel(tag: string): number {
  if (tag === 'H1') return 1;
  if (tag === 'H2') return 2;
  if (tag === 'H3') return 3;
  if (tag === 'H4') return 4;
  if (tag === 'H5') return 5;
  if (tag === 'H6') return 6;
  return 0;
}

/** Return the display string for the role bracket, e.g. "heading level=2". */
function getRoleDisplay(el: Element): string {
  const tag = el.tagName;

  // Heading level is embedded in the role bracket: [heading level=1]
  const hLevel = getHeadingLevel(tag);
  if (hLevel > 0) return `heading level=${hLevel}`;

  // Explicit role attribute
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;

  // Implicit role from tag → role mapping
  const implicit = IMPLICIT_ROLES[tag];
  if (implicit === undefined) return '';
  if (typeof implicit === 'function') return implicit(el) ?? '';
  return implicit;
}

/**
 * Roles that are "leaf" elements — they represent actionable or
 * content-bearing nodes. For these, textContent is a valid fallback
 * for the accessible name.
 *
 * Container roles (form, navigation, main, region, banner, list, etc.)
 * MUST NOT fall back to textContent because it would regurgitate all
 * descendant text that is already represented by child element lines.
 */
const LEAF_ROLES = new Set([
  'heading',
  'link',
  'button',
  'img',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'slider',
  'spinbutton',
  'listitem',
  'option',
]);

/** Returns the base role string (e.g. 'heading' from 'heading level=1'). */
function baseRole(roleDisplay: string): string {
  return roleDisplay.split(' ')[0];
}

/** True if the role is leaf-type (textContent is a valid name fallback). */
function isLeafRole(roleDisplay: string): boolean {
  const role = baseRole(roleDisplay);
  return !role || LEAF_ROLES.has(role);
}

/**
 * Compute the accessible name of an element.
 *
 * Order per simplified ARIA name-computation spec:
 *   1. aria-label
 *   2. aria-labelledby (text content of referenced element)
 *   3. alt (for images and input[type=image])
 *   4. title attribute
 *   5. <label for="id"> association
 *   6. wrapping <label> (input nested inside label)
 *   7. placeholder (for inputs)
 *   8. Visible text content — ONLY for leaf roles (heading, link, button, etc.)
 *
 * @param el - Element to compute name for
 * @param roleDisplay - Pre-computed role display string (avoids recomputation)
 */
function getAccessibleName(el: Element, roleDisplay: string): string {
  // 1. aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel?.trim()) return ariaLabel.trim();

  // 2. aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    try {
      const ref = (el.ownerDocument ?? document).getElementById(labelledBy);
      if (ref?.textContent) {
        const text = ref.textContent.trim();
        if (text) return text;
      }
    } catch {
      // getElementById doesn't throw, but guard anyway
    }
  }

  // 3. alt attribute (images and input[type=image])
  if (el.tagName === 'IMG' || el.tagName === 'INPUT') {
    const alt = el.getAttribute('alt');
    if (alt !== null && alt !== undefined) return alt;
  }

  // 4. title attribute
  const title = el.getAttribute('title');
  if (title?.trim()) return title.trim();

  // 5. Native label association via el.labels (HTMLInputElement,
  //    HTMLSelectElement, HTMLTextAreaElement, HTMLButtonElement).
  //    Handles both <label for="id"> and wrapping <label>.
  //    Only checks if element is in the document tree.
  if (
    el.isConnected &&
    ('labels' in el)
  ) {
    try {
      const labels = (el as HTMLInputElement).labels;
      if (labels && labels.length > 0) {
        const text = labels[0].textContent?.trim();
        if (text) return text;
      }
    } catch {
      // labels property may throw in unusual environments
    }
  }

  // 7. placeholder (for inputs)
  const placeholder = el.getAttribute('placeholder');
  if (placeholder?.trim()) return placeholder.trim();

  // 8. Visible text content — ONLY for leaf roles, not containers
  if (!isLeafRole(roleDisplay)) {
    // Container element — textContent would include children's text
    return '';
  }

  const text = el.textContent?.trim();
  if (text) {
    return text.length > MAX_ACCESSIBLE_NAME_LENGTH
      ? text.slice(0, MAX_ACCESSIBLE_NAME_LENGTH) + '...'
      : text;
  }

  return '';
}

/**
 * Get the current value for input/select/textarea elements.
 *
 * PC-WALK-HARDEN: Truncated to MAX_VALUE_LENGTH so a single input with
 * a megabyte of pasted text cannot dominate the snapshot's character
 * budget.
 */
function getValue(el: Element): string {
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
    const input = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    const raw = input.value ?? '';
    return raw.length > MAX_VALUE_LENGTH
      ? raw.slice(0, MAX_VALUE_LENGTH) + '...'
      : raw;
  }
  return '';
}

/** Build the states string (aria-* attributes + disabled/readonly). */
function getStates(el: Element): string {
  const parts: string[] = [];

  const expanded = el.getAttribute('aria-expanded');
  if (expanded !== null) parts.push(`expanded=${expanded}`);

  const checked = el.getAttribute('aria-checked');
  if (checked !== null) parts.push(`checked=${checked}`);

  const selected = el.getAttribute('aria-selected');
  if (selected !== null) parts.push(`selected=${selected}`);

  // HTML boolean properties — check on elements that support them
  if ('disabled' in el && (el as HTMLInputElement).disabled) parts.push('disabled');
  if ('readOnly' in el && (el as HTMLInputElement).readOnly) parts.push('readonly');

  return parts.join(' ');
}

/**
 * Find the nearest preceding heading (<h1>–<h6>) for an element.
 * Walks backwards through siblings, then up to parent and backwards again,
 * up to 50 ancestors. Returns the heading text trimmed, or '' if none found.
 * Used to enrich link text so "Read more" becomes identifiable:
 *   [link] "Read more — Demonstration in Gelderland town against anti-LGBTQI+ policy"
 */
export function nearestHeadingText(el: Element): string {
  const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  let current: Element | null = el;
  for (let depth = 0; depth < 20 && current; depth++) {
    // Walk backwards through preceding siblings
    let sib = current.previousElementSibling;
    while (sib) {
      if (HEADING_TAGS.has(sib.tagName)) {
        const text = sib.textContent?.trim();
        if (text) return text.length > 100 ? text.slice(0, 100) + '...' : text;
      }
      // Check inside container siblings for nested headings (article > h2)
      // but skip leaf elements to avoid expensive querySelector on flat nodes
      if (sib.children.length > 0) {
        const inner = sib.querySelector('h1, h2, h3, h4, h5, h6');
        if (inner) {
          const text = inner.textContent?.trim();
          if (text) return text.length > 100 ? text.slice(0, 100) + '...' : text;
        }
      }
      sib = sib.previousElementSibling;
    }
    current = current.parentElement;
  }
  return '';
}

/**
 * Get the navigation target for links and forms.
 *
 * PC-WALK-HARDEN: Truncate href/form action URLs to MAX_ATTRIBUTE_LENGTH
 * so an adversarial long query-string URL cannot blow up the snapshot.
 */
function getTarget(el: Element): string {
  const tag = el.tagName;
  if (tag === 'A') {
    const href = (el as HTMLAnchorElement).getAttribute('href');
    // Skip empty, fragment-only, and javascript: links
    if (href && href !== '#' && !href.startsWith('javascript:')) {
      return href.length > MAX_ATTRIBUTE_LENGTH
        ? href.slice(0, MAX_ATTRIBUTE_LENGTH) + '...'
        : href;
    }
  }
  if (tag === 'FORM') {
    const action = (el as HTMLFormElement).action;
    if (action) {
      return action.length > MAX_ATTRIBUTE_LENGTH
        ? action.slice(0, MAX_ATTRIBUTE_LENGTH) + '...'
        : action;
    }
  }
  if (tag === 'AREA') {
    const href = el.getAttribute('href');
    if (href) {
      return href.length > MAX_ATTRIBUTE_LENGTH
        ? href.slice(0, MAX_ATTRIBUTE_LENGTH) + '...'
        : href;
    }
  }
  return '';
}

/**
 * Format one role-bearing element into a line entry.
 * Called only for elements with a semantic role (hasRole === true).
 */
function formatElement(
  el: Element,
  depth: number,
  roleDisplay: string,
): LineEntry | null {
  let name = getAccessibleName(el, roleDisplay);
  const value = getValue(el);
  const states = getStates(el);
  const target = getTarget(el);

  // Enrich link text with nearest preceding heading so "Read more" becomes
  // identifiable: [link] "Read more — LGBTQ article headline" → /url
  if (roleDisplay === 'link') {
    const heading = nearestHeadingText(el);
    if (heading && name && !name.toLowerCase().includes(heading.toLowerCase().slice(0, 20))) {
      name = `${name} — ${heading}`;
    }
  }

  // Format: [role] "name" [| value="..."] [| states] [ → target]
  const indent = '  '.repeat(depth);
  let line = `${indent}[${roleDisplay}] "${name}"`;
  if (value) line += ` | value="${value}"`;
  if (states) line += ` | ${states}`;
  if (target) line += ` → ${target}`;

  return { text: line, depth, role: roleDisplay };
}

// ---------------------------------------------------------------------------
// Tree construction
// ---------------------------------------------------------------------------

/**
 * Mutable shared counter passed through recursive walks so a single
 * node-visit budget caps work even though recursion is split across
 * `processElement` (light DOM) and `processShadowChildren` (shadow DOM).
 */
interface WalkBudget {
  visited: number;
  /** True once `visited` exceeds `MAX_NODES_VISITED`. */
  exhausted: boolean;
}

/**
 * Process one child node (element / text). Shared by light-DOM and
 * shadow-DOM walks so the role-emptiness + truncation logic applies
 * uniformly.
 *
 * PC-WALK-HARDEN: truncates text-node payloads to MAX_TEXT_NODE_LENGTH
 * so a single runaway text node cannot dominate the budget.
 */
function processChild(node: Node, hasRole: boolean, depth: number, lines: LineEntry[]): void {
  if (node.nodeType === Node.ELEMENT_NODE) {
    processElement(node as Element, depth, lines, { visited: 0, exhausted: false });
    return;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    // Only emit text nodes for elements WITHOUT roles.
    // Elements with roles already capture text content via accessible name.
    if (hasRole) return;
    const rawText = (node as Text).data ?? node.textContent ?? '';
    const text = rawText.trim();
    if (!text) return;
    const truncated =
      text.length > MAX_TEXT_NODE_LENGTH
        ? text.slice(0, MAX_TEXT_NODE_LENGTH) + '...'
        : text;
    lines.push({
      text: '  '.repeat(depth) + truncated,
      depth,
      role: 'text',
    });
  }
  // Comment / CDATA / other: ignored by design. Script + style content
  // are already filtered upstream by SKIP_TAGS so they cannot leak in
  // even at elements without roles.
}

/**
 * Walk a single element node and collect its line entry + children.
 *
 * Nesting rule: non-role elements (div, span, label, p, etc.) act as
 * transparent wrappers — they do NOT add a nesting level. Their children
 * are processed at the same depth, so the output tree reflects real semantic
 * nesting, not HTML wrapper artifacts.
 *
 * PC-WALK-HARDEN: Three additions vs. the original walker:
 *   1. Walks an OPEN shadow root on the host if present (closed shadow
 *      roots are skipped — `element.shadowRoot` is null for them).
 *   2. Respects a shared node-visit budget so SPAs with 10k+ nodes
 *      terminate the walk instead of hanging the content script.
 *   3. Each DOM read is wrapped so accessibility quirks or detached
 *      nodes can never throw out of the walker.
 */
function processElement(el: Element, depth: number, lines: LineEntry[], budget: WalkBudget): void {
  if (budget.exhausted) return;
  budget.visited++;
  if (budget.visited > MAX_NODES_VISITED) {
    budget.exhausted = true;
    return;
  }

  let skipped = false;
  try {
    skipped = shouldSkipElement(el);
  } catch {
    return;
  }
  if (skipped) return;

  let roleDisplay = '';
  try {
    roleDisplay = getRoleDisplay(el);
  } catch {
    return;
  }
  const hasRole = roleDisplay !== '';

  if (hasRole) {
    try {
      const entry = formatElement(el, depth, roleDisplay);
      if (entry) lines.push(entry);
    } catch {
      // Never let a bad element (custom / foreign-attribute) crash the walker.
    }
  }

  const childDepth = hasRole ? depth + 1 : depth;

  let children: NodeListOf<ChildNode>;
  try {
    children = el.childNodes;
  } catch {
    return;
  }
  for (let i = 0; i < children.length; i++) {
    if (budget.exhausted) return;
    processChild(children[i], hasRole, childDepth, lines);
  }

  // Walk open shadow root (closed => element.shadowRoot === null).
  processShadowChildren(el, hasRole, childDepth, lines, budget);
}

/**
 * Walk the open shadow root attached to `el`, if any. Closed shadow
 * roots expose no `shadowRoot` property so this is a no-op for them
 * by spec. The outer try/catch handles older hosts / polyfills where
 * the accessor itself throws.
 *
 * PC-WALK-HARDEN: Shadow DOM hosts (any framework using Web Components)
 * now enumerate correctly. Pages whose entire interactive UI lives in a
 * closed shadow root will not crash — they just contribute nothing,
 * which is what `element.shadowRoot === null` would imply anyway.
 */
function processShadowChildren(
  el: Element,
  hasRole: boolean,
  depth: number,
  lines: LineEntry[],
  budget: WalkBudget,
): void {
  let shadow: ShadowRoot | null;
  try {
    shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
  } catch {
    return;
  }
  if (!shadow) return;
  let shadowChildren: NodeListOf<ChildNode>;
  try {
    shadowChildren = shadow.childNodes;
  } catch {
    return;
  }
  for (let i = 0; i < shadowChildren.length; i++) {
    if (budget.exhausted) return;
    processChild(shadowChildren[i], hasRole, depth, lines);
  }
}

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

/**
 * Truncate the line list when it exceeds maxChars.
 *
 * Strategy per TO-DEV §2 (Token-budget guard §3.4):
 *   Keep first KEEP_DEPTH levels fully, then summarize deeper elements as:
 *     "… N more children (role=...)"
 *
 * Rule: never silently drop interactive elements in top KEEP_DEPTH levels.
 * (Since all top-KEEP_DEPTH lines are kept, this is satisfied by design.)
 */
function truncateLines(lines: LineEntry[], maxChars: number): string {
  if (lines.length === 0) return '';

  // Full output — no truncation needed
  const fullText = lines.map((l) => l.text).join('\n');
  if (fullText.length <= maxChars) return fullText;

  // Truncation needed: keep depth < KEEP_DEPTH, summarize the rest
  const kept: LineEntry[] = [];
  const deep: LineEntry[] = [];

  for (const l of lines) {
    if (l.depth < KEEP_DEPTH) {
      kept.push(l);
    } else {
      deep.push(l);
    }
  }

  // Count roles for the summary
  const roleCount = new Map<string, number>();
  for (const l of deep) {
    const r = l.role || 'element';
    roleCount.set(r, (roleCount.get(r) ?? 0) + 1);
  }

  // Find the most common role(s) for the summary
  const sorted = [...roleCount.entries()].sort((a, b) => b[1] - a[1]);
  const topRoles = sorted.slice(0, 3);

  let summary: string;
  if (topRoles.length === 1) {
    summary = `… ${deep.length} more children (${topRoles[0][0]})`;
  } else {
    const list = topRoles.map(([r, c]) => `${r}=${c}`).join(', ');
    summary = `… ${deep.length} more children (${list})`;
  }

  const keptText = kept.map((l) => l.text).join('\n');
  return `${keptText}\n  ${summary}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract page structure from a given root element.
 * Pure function — no DOM mutation, no global references beyond the passed root.
 *
 * @param root  - Root element (e.g. document.body, or a test fixture container)
 * @param maxChars - Maximum output character length before truncation (default 1500)
 * @returns Compact indented text tree describing the page structure
 */
export function extractPageStructureFromRoot(
  root: HTMLElement,
  maxChars: number = DEFAULT_MAX_CHARS,
): string {
  const lines: LineEntry[] = [];

  for (let i = 0; i < root.childNodes.length; i++) {
    const child = root.childNodes[i];

    if (child.nodeType === Node.ELEMENT_NODE) {
      processElement(child as Element, 0, lines, { visited: 0, exhausted: false });
    } else if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent?.trim();
      if (text) {
        lines.push({ text, depth: 0, role: 'text' });
      }
    }
  }

  return truncateLines(lines, maxChars);
}

/**
 * Extract page structure from the current document body.
 * Thin wrapper over `extractPageStructureFromRoot(document.body)`.
 *
 * @returns Compact indented text tree for the current page
 */
export function extractPageStructure(): string {
  if (!document?.body) return '';
  return extractPageStructureFromRoot(document.body);
}

// ---------------------------------------------------------------------------
// Image enumeration (Phase J + Image-describe feature)
//
// Contrast with `extractPageStructureFromRoot`, which skips `<img>`
// elements without alt text (good for the LLM input — alt-less images
// are usually decorative chrome). The describe-image feature needs ALL
// images, including the alt-free ones, because that's exactly the
// cohort where vision fallback is most useful.
//
// Output is bounded — first MAX_IMAGES only, then stop walking. Per
// session-memory on cost ceilings, the list-and-pick speak should fit
// in two spoken sentences for a single page.
// ---------------------------------------------------------------------------

export interface ImageEntry {
  /** 1-based position in the enumeration. Matches what the LLM emits
   *  for `{"action":"describe_image","elementIndex":N}`. */
  index: number;
  /** Best accessible name in priority order: aria-label → alt → src
   *  filename. Empty string if completely unlabeled. */
  label: string;
  /** Raw alt text (lower-cased, trimmed) or null. */
  alt: string | null;
  /** Raw aria-label or null. */
  ariaLabel: string | null;
  /** Resolved href (currentSrc preferred over src). null when missing. */
  src: string | null;
  /** Bounding rect at call time. Width/height are CSS pixels; client
   *  coords. Use devicePixelRatio to convert to screenshot pixels. */
  bbox: { x: number; y: number; width: number; height: number };
}

/** Hard cap. List speak must fit two sentences (~50 words); 12 labels
 *  × ~3 words each = ~36 spoken words. Anything more gets truncated. */
export const MAX_IMAGES = 12;

/**
 * Enumerate every `<img>` under a root element with metadata suitable
 * for the describe-image / list-images actions.
 *
 * Pure function over the passed `root`. No mutation, no IO beyond DOM
 * reads. jsdom-testable.
 *
 * @param root      - Root element; defaults to document.body
 * @param maxImages - Max entries to return (default MAX_IMAGES)
 * @returns Array of ImageEntry, in DOM order, capped at maxImages
 */
export function enumerateImages(
  root?: HTMLElement,
  maxImages: number = MAX_IMAGES,
): ImageEntry[] {
  const target = root ?? document?.body ?? null;
  if (!target) return [];

  const imgs = target.querySelectorAll('img');
  const out: ImageEntry[] = [];
  const cap = Math.max(0, maxImages);

  for (let i = 0; i < imgs.length && out.length < cap; i++) {
    const el = imgs[i] as HTMLImageElement;

    // Skip <img> with no rendered size — zero-area boxes cause cdn-loop
    // crop math. SSR images that haven't loaded yet will fall out.
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;

    const ariaLabel = el.getAttribute('aria-label')?.trim() ?? null;
    const alt = el.getAttribute('alt')?.trim() ?? null;
    let label = ariaLabel || alt || '';
    if (!label) {
      const srcValue = el.currentSrc || el.getAttribute('src') || '';
      // Use the filename as a last-resort label: "Image at /foo/bar.jpg"
      const filename = srcValue.split('/').pop()?.split('?')[0] ?? '';
      label = filename ? `unlabeled image — ${filename}` : 'unlabeled image';
    }

    out.push({
      index: out.length + 1,
      label,
      alt,
      ariaLabel,
      src: el.currentSrc || el.getAttribute('src') || null,
      bbox: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
    });
  }
  return out;
}

/**
 * Format an array of ImageEntry into a single spoken string the user
 * can hear in one or two breaths. Index prefix lets the user say
 * "describe image 1" without owning the label.
 *
 * @param entries - ImageEntry[] (max 12, truncate at the boundary)
 * @returns Spoken list, or a single "this page has no images." line
 */
export function speakImageList(entries: ImageEntry[]): string {
  if (entries.length === 0) return 'This page has no images.';
  const visible = entries.slice(0, MAX_IMAGES);
  const parts = visible.map(
    (e) => `image ${e.index}: ${truncateSpoken(e.label, 60)}`,
  );
  const headline =
    visible.length === entries.length
      ? `This page has ${entries.length} image${entries.length === 1 ? '' : 's'}.`
      : `This page has at least ${entries.length} images (the rest are below the fold).`;
  return `${headline} ${parts.join('. ')}.`;
}

/** Trim a label to "speech-friendly" length without ellipsis punctuation. */
function truncateSpoken(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd();
}

// ---------------------------------------------------------------------------
// Link enumeration (list-links feature)
//
// Mirrors enumerateImages/speakImageList. Walks the snapshot's elements
// array to find <a> elements with valid hrefs, preserving each link's
// real index so "open number N" maps directly to a click action.
//
// Dedup by href — news sites repeat the same story link in hero, list,
// and footer. The user hears each link once; the index points to
// the first occurrence in DOM order.
// ---------------------------------------------------------------------------

export interface LinkEntry {
  /** 1-based index in the page snapshot. Maps directly to the
   *  integer in PAGE STRUCTURE so "open number N" clicks the right link. */
  index: number;
  /** Visible text or aria-label of the link. Truncated for speech. */
  text: string;
  /** Nearest preceding heading (<h1>–<h6>), if found. Appended to text for
   *  identification so "Read more" becomes "Read more — Article headline". */
  heading: string;
  /** Resolved href value. */
  href: string;
}

/** Hard cap for link enumeration. Same rationale as MAX_IMAGES — spoken
 *  list must fit in ~2 breaths for a blind user. */
export const MAX_LINKS = 30;

/**
 * Enumerate every `<a href>` from a snapshot or a root DOM element,
 * preserving each link's real index so "open number N" maps
 * directly to a click action. Deduplicates by href, skips
 * fragment-only / javascript: / empty-href links, and links with no
 * meaningful visible text.
 *
 * Pure function — no DOM mutation, no IO.
 *
 * @param snapshotOrRoot - A snapshot `{ elements }` OR an HTMLElement (root)
 * @param maxLinks - Max entries to return (default MAX_LINKS)
 * @returns Array of LinkEntry, in DOM order, capped at maxLinks
 */
export function enumerateLinks(
  snapshotOrRoot: { elements: HTMLElement[] } | HTMLElement,
  maxLinks: number = MAX_LINKS,
): LinkEntry[] {
  // Support both snapshot and root DOM element (root uses snapshot-like wrapper)
  const elements: HTMLElement[] =
    'elements' in snapshotOrRoot
      ? snapshotOrRoot.elements
      : Array.from((snapshotOrRoot as HTMLElement).querySelectorAll('*')) as HTMLElement[];

  const seen = new Set<string>();
  const out: LinkEntry[] = [];
  const cap = Math.max(0, maxLinks);

  for (let i = 0; i < elements.length && out.length < cap; i++) {
    const el = elements[i];
    if (!el || el.tagName !== 'A') continue;

    const href = (el as HTMLAnchorElement).getAttribute('href') ?? '';
    // Skip empty, fragment-only, and javascript: links
    if (!href || href === '#' || href.startsWith('#') || href.startsWith('javascript:')) continue;

    // Skip hidden links
    try {
      if (el.matches('[aria-hidden="true"], [hidden], [inert]')) continue;
    } catch { /* ignore invalid selectors */ }

    // Dedup by href
    const canon = href.trim().toLowerCase();
    if (seen.has(canon)) continue;
    seen.add(canon);

    // Get meaningful text: aria-label > textContent
    const ariaLabel = el.getAttribute('aria-label')?.trim() ?? '';
    const rawText = el.textContent?.trim() ?? '';
    const text = ariaLabel || rawText;
    if (!text) continue;

    // Enrich with nearest preceding heading so "Read more" becomes identifiable
    const heading = nearestHeadingText(el);
    const displayText = heading && !text.toLowerCase().includes(heading.toLowerCase().slice(0, 20))
      ? `${text} — ${heading}`
      : text;

    out.push({ index: i + 1, text: displayText, heading, href });
  }
  return out;
}

/**
 * Format an array of LinkEntry into a single spoken string.
 * Each entry is prefixed with "link N:" so the user can say
 * "open number N" to click the real on-page link.
 *
 * @param entries - LinkEntry[] (max MAX_LINKS, truncate at boundary)
 * @returns Spoken list, or a single "no links" line
 */
export function speakLinkList(entries: LinkEntry[]): string {
  if (entries.length === 0) return 'This page has no links.';
  const visible = entries.slice(0, MAX_LINKS);
  const parts = visible.map(
    (e) => `Number ${e.index}: ${truncateSpoken(e.text, 80)}`,
  );
  const headline =
    visible.length === entries.length
      ? `This page has ${entries.length} link${entries.length === 1 ? '' : 's'}.`
      : `This page has at least ${entries.length} links.`;
  return `${headline} ${parts.join('. ')}.`;
}

