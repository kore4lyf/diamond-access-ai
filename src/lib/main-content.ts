/**
 * Diamond Access AI — Main-content extraction
 *
 * Phase L (PC-EXT-MAINCONT) — long-form read-aloud + summarize_article.
 *
 * Site-agnostic extractor that returns the FULL readable prose of
 * a page's main content (articles, threads, product descriptions,
 * recipes, READMEs). Built on Mozilla Readability's paragraph-scoring
 * + ancestor-propagation approach + class/id weighting so it works
 * on news, forum, recipe, product, and SPA pages.
 *
 * Three layers, in priority order:
 *   1. Scored subtree (Readability-style) — paragraph roots and
 *      their ancestors, with class/id weight squashing sidebar/footer
 *      noise into negative scores.
 *   2. Largest visible-text div/section — fallback when nothing scores
 *      above threshold (forum pages, dense listings, scant heuristic
 *      signal).
 *   3. Document body innerText — last-resort cap so Diamond never
 *      says "couldn't extract" on a page that visibly has text.
 *
 * Privacy: pure DOM-walk, no fetch, no chrome.storage reads. The
 * returned prose can carry personal data from the page (comments,
 * forum posters, etc.); the caller (SW READ_ARTICLE handler) decides
 * whether to send it through the LLM.
 *
 * Source of truth: doc/DOC-READ-ALOUD.md (Phase L docs).
 */

export interface Candidate {
  selector: string;
  title: string;
  preview: string;
  score: number;
  tags: string[];
}

export interface MainContent {
  title: string;
  prose: string;
  candidates: Candidate[];
  selected: number;
}

// ---------------------------------------------------------------------------
// Class / id signal weights (the "not only news" fix).
// Single highest-leverage signal Mozilla, Quartz, and adobo's
// "best of" libraries all share: positive class tokens mark body
// regions; negative tokens mark sidebar/comment/footer noise.
// ---------------------------------------------------------------------------

const POSITIVE_TOKENS = new Set([
  'article', 'content', 'post', 'story', 'body', 'text', 'entry',
  'description', 'main', 'read', 'message', 'recipe', 'instructions',
  'ingredients', 'summary', 'lead',
]);

const NEGATIVE_TOKENS = new Set([
  'comment', 'sidebar', 'footer', 'header', 'ad', 'ads', 'nav',
  'promo', 'related', 'share', 'meta', 'banner', 'menu', 'toolbar',
  'breadcrumb', 'pagination', 'cookie', 'consent', 'modal',
]);

/**
 * Look up a class/id token and return the structural weight for the
 * element. Returns 0 for unmatched (default).
 *
 * Tuned so positive IDs (id="story-body") outvote negative classes
 * (class="comments") — single highest signal wins, not summed, to
 * avoid inflation on multi-class elements like `<aside class="main
 * sidebar-links">`.
 */
function getClassWeight(el: Element): number {
  const collectTokens = (raw: string | null): string[] => {
    if (!raw) return [];
    return raw
      .toLowerCase()
      .split(/[\s_-]+/)
      .filter((tok) => tok.length > 1);
  };

  const tokens = [
    ...collectTokens(el.getAttribute('id')),
    ...collectTokens(el.className?.toString?.() ?? ''),
  ];

  let pos = 0;
  let neg = 0;
  for (const t of tokens) {
    if (POSITIVE_TOKENS.has(t)) pos += 25;
    if (NEGATIVE_TOKENS.has(t)) neg += 25;
  }
  return pos - neg;
}

/**
 * Find the strongest structural-weight signal in the ancestor chain.
 * Returns the highest single score (capped at +25 per element), so
 * one well-named ancestor wins, but every ancestor is consulted to
 * handle templates where the readable content is wrapped deep.
 *
 * Positive ancestor (e.g. `<section id="story-body">`) wins over
 * positive class. The deeper ancestors get a slight preference
 * through ascending weighting — closer-to-leaf means closer-to-content.
 */
function getAncestorAnchorWeight(el: Element, root: Element, depthLimit = 5): number {
  let cur: Element | null = el;
  let depth = 0;
  let best = 0;
  const stack: { el: Element; w: number }[] = [];

  while (cur && depth <= depthLimit) {
    const w = getClassWeight(cur);
    if (w > best) best = w;
    stack.push({ el: cur, w });
    if (cur === root) break;
    cur = cur.parentElement;
    depth++;
  }

  // Ancestors get a proximity bonus: leaf content's nearest positive
  // ancestor is more authoritative than a remote one.
  for (let i = 0; i < stack.length; i++) {
    const proximity = stack.length - i;
    if (stack[i].w > 0 && proximity * 2 > best) best = proximity * 2;
  }
  return Math.min(best, 100);
}

// ---------------------------------------------------------------------------
// Paragraph scoring — Mozilla-style. Each leaf-ish prose node gets a
// score from its own text, a comma bonus (proxy for sentence density),
// and the strongest positive ancestor weight. Ancestor scores
// PROPAGATE up the tree so the largest contentful subtree wins.
// ---------------------------------------------------------------------------

/**
 * Tag set for elements that contribute paragraph-style text. Same list
 * as the previous walker but with the priority order explicit so we
 * can score per-element.
 */
const PROSE_LEAF_TAGS = new Set([
  'P', 'LI', 'PRE', 'BLOCKQUOTE', 'FIGCAPTION',
  'TD', 'TH',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
]);

/** Whole-article threshold below which we don't trust the scorer. */
const WHOLE_ARTICLE_CHARS = 140;

/**
 * Skip set: these are NEVER root candidates or prose contributors,
 * even if their innerText is large. (No longer using SKIP_ROLES
 * inside the walker; we do this at score-candidate time only.)
 */
const NEVER_PROSE_TAGS = new Set([
  'NAV', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'IFRAME', 'FORM',
  'FOOTER', 'HEADER', 'ASIDE', 'BUTTON',
]);

const NEVER_PROSE_ROLES = new Set([
  'navigation', 'banner', 'contentinfo', 'complementary', 'search',
  'form', 'dialog', 'alert', 'menu', 'menubar', 'toolbar', 'tablist',
]);

/**
 * Walk the tree, score every prose leaf in-place, then sum into each
 * ancestor's cumulative score. Returns the cumulative map keyed on
 * Element (live refs — no selector round-trip, HY3 PC-EXT-MAINCONT
 * correction removing the page-snapshot fragility).
 */
function propagateScores(root: Element): Map<Element, number> {
  const totals = new Map<Element, number>();

  const visit = (el: Element): void => {
    if (NEVER_PROSE_TAGS.has(el.tagName)) return;
    const role = el.getAttribute('role');
    if (role && NEVER_PROSE_ROLES.has(role)) return;

    let own = 0;
    if (PROSE_LEAF_TAGS.has(el.tagName)) {
      const txt = (el.textContent ?? '').trim();
      if (txt.length > 0) {
        const commas = (txt.match(/,/g) ?? []).length;
        const ancW = getAncestorAnchorWeight(el, root);
        own = txt.length + commas * 12 + ancW;
      }
    }

    if (own > 0) totals.set(el, own);

    const sumIntoAncestors = (score: number): void => {
      let cur: Element | null = el.parentElement;
      while (cur && cur !== root.parentElement) {
        const prev = totals.get(cur) ?? 0;
        totals.set(cur, prev + score);
        cur = cur.parentElement;
      }
    };

    if (own > 0) sumIntoAncestors(own);

    for (const child of Array.from(el.children)) {
      visit(child);
    }
  };

  visit(root);
  return totals;
}

// ---------------------------------------------------------------------------
// Winner selection — highest-cumulative-score subtree above threshold,
// with class/id weighting already baked into the propagation scores.
// Hydrates candidates array for the debug hook.
// ---------------------------------------------------------------------------

function selectWinner(
  root: Element,
  scores: Map<Element, number>,
): { winner: Element | null; candidates: Candidate[] } {
  const candidates: Candidate[] = [];

  for (const [el, score] of scores) {
    if (score <= 0) continue;
    candidates.push({
      selector: getNodeSelector(el),
      title: extractTitle(el),
      preview: ((el.textContent ?? '').trim().slice(0, 200) + '…').trim(),
      score,
      tags: deriveTags(el, score),
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  // First candidate with cumulative score ≥ WHOLE_ARTICLE_CHARS wins.
  // No 200-char per-node floor was the strict rule HY3 surfaced —
  // short blurbs still surface via the fallback chain below.
  const winner =
    candidates.find((c) => c.score >= WHOLE_ARTICLE_CHARS)?.selector ?? null;

  if (!winner) {
    return { winner: null, candidates };
  }

  const winnerNode = resolveSelector(winner, root);
  return { winner: winnerNode, candidates };
}

function deriveTags(el: Element, score: number): string[] {
  const tags: string[] = [];
  const w = getClassWeight(el);
  if (w > 0) tags.push('positive-class');
  if (w < 0) tags.push('negative-class');
  if (score >= 800) tags.push('high-confidence');
  else if (score >= 200) tags.push('mid-confidence');
  else tags.push('low-confidence');
  if (el.tagName === 'ARTICLE') tags.push('semantic-article');
  if (el.tagName === 'MAIN') tags.push('semantic-main');
  return tags;
}

function extractTitle(node: Element): string {
  const h1 = node.querySelector('h1');
  if (h1?.textContent) {
    const t = h1.textContent.trim();
    if (t) return t;
  }
  const ariaLabel = node.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel;
  const ogTitle = node.querySelector('meta[property="og:title"]');
  if (ogTitle) {
    const c = ogTitle.getAttribute('content')?.trim();
    if (c) return c;
  }
  return '';
}

function getNodeSelector(node: Element): string {
  if (node.id) return `#${CSS.escape(node.id)}`;
  const tag = node.tagName.toLowerCase();
  const parent = node.parentElement;
  if (!parent) return tag;
  const siblings = Array.from(parent.children).filter(
    (c) => c.tagName === node.tagName,
  );
  const index = siblings.indexOf(node) + 1;
  if (siblings.length > 1) {
    return `${tag}:nth-of-type(${index})`;
  }
  return tag;
}

function resolveSelector(selector: string, root: Element): Element | null {
  // First try the selector as-is. If it's an id selector, fall back
  // to a getElementById-style lookup. Otherwise querySelector walks
  // the subtree.
  try {
    const el = root.querySelector(selector);
    return el;
  } catch {
    // nth-of-type or escape mismatch — fall through
  }
  if (selector.startsWith('#')) {
    const id = selector.slice(1).replace(/\\/g, '');
    return root.ownerDocument?.getElementById(id) ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prose extraction — visibility-aware innerText, walk every prose leaf,
// strip subtrees that scored negative. No 200-char per-node floor.
// ---------------------------------------------------------------------------

const ELEMENT_SKIP_TAGS = new Set(NEVER_PROSE_TAGS);
const ELEMENT_SKIP_ROLES = new Set(NEVER_PROSE_ROLES);

function extractProseFromNode(root: Element): string {
  const baselineText = (() => {
    if (typeof (root as HTMLElement).innerText === 'string') {
      return (root as HTMLElement).innerText.trim();
    }
    return (root.textContent ?? '').replace(/\s+/g, ' ').trim();
  })();

  const buf: string[] = [];
  const seen = new Set<string>();
  const dedupePush = (line: string): void => {
    const key = line.slice(0, 80).trim();
    if (!seen.has(key)) {
      seen.add(key);
      buf.push(line);
    }
  };

  const walk = (el: Element): void => {
    if (ELEMENT_SKIP_TAGS.has(el.tagName)) return;
    const role = el.getAttribute('role');
    if (role && ELEMENT_SKIP_ROLES.has(role)) return;

    if (PROSE_LEAF_TAGS.has(el.tagName)) {
      const text = (el.textContent ?? '').trim();
      if (text) dedupePush(text);
      return;
    }

    // Loose-div text emission (Path B change 2)
    if (el.tagName === 'DIV' && el.children.length === 0) {
      const text = (el.textContent ?? '').trim();
      if (text.length > 30) dedupePush(text);
      return;
    }

    for (const child of Array.from(el.children)) {
      walk(child as Element);
    }
  };
  walk(root);

  // Use baselineText only as fallback when no prose leaves were found
  if (buf.length === 0 && baselineText.length >= WHOLE_ARTICLE_CHARS) {
    buf.push(baselineText);
  }

  return buf.join('\n\n').trim();
}

// ---------------------------------------------------------------------------
// Fallback chain. The whole point of this rewrite is that Diamond
// never emits "Sorry, I couldn't extract" on a page with visible text.
// ---------------------------------------------------------------------------

function fallbackLargestVisibleText(root: Element): Element | null {
  let bestEl: Element | null = null;
  let bestLen = 0;

  const visit = (el: Element): void => {
    if (NEVER_PROSE_TAGS.has(el.tagName)) return;
    const role = el.getAttribute('role');
    if (role && NEVER_PROSE_ROLES.has(role)) return;

    const text = ((el as HTMLElement).innerText ?? el.textContent ?? '').trim();
    if (text.length > bestLen) {
      bestEl = el;
      bestLen = text.length;
    }
    for (const child of Array.from(el.children)) {
      visit(child);
    }
  };
  visit(root);
  return bestEl;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

export function extractMainContent(root: Element = document.body): MainContent {
  // Primary path: Readability-style propagation.
  const scores = propagateScores(root);
  const { winner, candidates } = selectWinner(root, scores);

  if (winner) {
    return {
      title: extractTitle(winner),
      prose: extractProseFromNode(winner),
      candidates,
      selected: 0,
    };
  }

  // Fallback A: largest visible-text subtree from the whole page.
  const visible = fallbackLargestVisibleText(root);
  if (visible) {
    const fallbackCandidates: Candidate[] = [
      {
        selector: getNodeSelector(visible),
        title: extractTitle(visible),
        preview: ((visible.textContent ?? '').trim().slice(0, 200) + '…').trim(),
        score: 1,
        tags: ['fallback-largest'],
      },
      ...candidates,
    ];
    return {
      title: extractTitle(visible),
      prose: extractProseFromNode(visible),
      candidates: fallbackCandidates,
      selected: 0,
    };
  }

  // Fallback B: document.body innerText trimmed — last resort. This is
  // the no-empty-prose guarantee: any page with visible text returns
  // SOMETHING readable.
  const bodyText =
    typeof (root as HTMLElement).innerText === 'string'
      ? (root as HTMLElement).innerText.trim()
      : (root.textContent ?? '').replace(/\s+/g, ' ').trim();

  return {
    title: '',
    prose: bodyText,
    candidates,
    selected: -1,
  };
}

// ── Dev-only debug hook ──────────────────────────────────────────────────
//
// `pnpm dev` registers `window.__diamondMainContentDebug()` — call it
// from DevTools to inspect the ranked candidates for the current page.
// In production builds (`pnpm build`), Vite tree-shakes this branch
// out via `import.meta.env.DEV` so nothing ships.
declare global {
  interface Window {
    __diamondMainContentDebug?: () => MainContent;
  }
}

if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
  if (typeof window !== 'undefined') {
    window.__diamondMainContentDebug = () => {
      const result = extractMainContent();
      // eslint-disable-next-line no-console
      console.log('[Diamond] main-content candidates:');
      result.candidates.forEach((c, i) => {
        // eslint-disable-next-line no-console
        console.log(
          `  #${i + 1} [${c.score.toFixed(0)}] ${c.selector}\n` +
            `     title: ${c.title || '(no title)'}\n` +
            `     preview: ${c.preview.slice(0, 120)}…\n` +
            `     tags: ${c.tags.join(', ') || '-'}`,
        );
      });
      // eslint-disable-next-line no-console
      console.log(
        `[Diamond] selected: "${
          result.title || '(no title)'
        }" prose=${result.prose.length}ch`,
      );
      return result;
    };
  }
}
