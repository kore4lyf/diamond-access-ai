/**
 * Diamond Access AI — Main-content extraction
 *
 * Phase L (PC-EXT-MAINCONT) — long-form read-aloud + summarize_article.
 *
 * Returns the FULL readable prose of a page's main content (article,
 * thread, recipe, product description, README), not the nav tree.
 * Site-agnostic by design — same scoring works on BBC News, Reddit,
 * Amazon, GitHub, recipe blogs. Tested with multi-site dry-run
 * corpus before shipping (NOT BBC alone — BBC is a trap).
 *
 * Privacy: returns prose only — no nav/footer/sidebar/comment blocks.
 * Pure DOM-walk output, same privacy contract as page-snapshot.
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

/**
 * Score a candidate node. Higher = more likely "the main readable block".
 *
 *   score = semanticDensity × (1 − linkDensity) × siblingContentCount
 *
 * Substitutions vs. the original "semantic density" plan (PC-EXT-MAINCONT
 * tweak #1): semanticDensity is text-to-markup-ratio, no tokenizer.
 * linkDensity is link-text ÷ total-text (penalizes nav-heavy blocks).
 * siblingContentCount is log2(1+N) for N significant siblings, so a
 * tight cluster of similar-sized content blocks (article body across
 * many `<p>`) beats a one-off big div with mixed-purpose content.
 */
export function scoreCandidate(root: Element): { score: number; tags: string[] } {
  const tags: string[] = [];
  const fullText = (root.textContent ?? '').trim();
  const textLen = fullText.length;

  if (textLen < 200) {
    return { score: 0, tags: ['too-short'] };
  }

  const innerHTML = root.innerHTML ?? '';
  const markupLen = innerHTML.length - textLen;
  if (markupLen < 0) {
    return { score: 0, tags: ['invalid-markup'] };
  }

  const anchorText = Array.from(root.querySelectorAll('a, [role="link"]'))
    .map((a) => (a.textContent ?? '').trim())
    .join(' ');
  const linkTextLen = anchorText.length;
  const linkDensity = textLen === 0 ? 1 : linkTextLen / textLen;

  const parent = root.parentElement;
  let siblingContentCount = 1;
  if (parent) {
    const siblings = Array.from(parent.children);
    const significant = siblings.filter((s) => {
      const sl = (s.textContent ?? '').trim().length;
      return sl > 200 && Math.abs(sl - textLen) < textLen * 0.5;
    });
    siblingContentCount = Math.log2(1 + significant.length);
  }
  if (siblingContentCount > 1) tags.push('cluster');

  const semanticDensity = textLen / (textLen + markupLen);

  const score = semanticDensity * (1 - linkDensity) * siblingContentCount;
  if (linkDensity > 0.4) tags.push('link-heavy');
  if (semanticDensity < 0.3) tags.push('markup-heavy');

  return { score, tags };
}

/**
 * Build a CSS selector that uniquely identifies a node within its
 * subtree. Prefers id; falls back to tag + nth-of-type.
 */
export function getNodeSelector(node: Element): string {
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

const SKIP_TAGS = new Set([
  'NAV',
  'SCRIPT',
  'STYLE',
  'SVG',
  'NOSCRIPT',
  'IFRAME',
  'FORM',
  'ASIDE',
  'FOOTER',
  'HEADER',
]);
const SKIP_ROLES = new Set([
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'search',
  'form',
]);
const TEXT_TAGS = new Set([
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'PRE',
  'BLOCKQUOTE',
  'FIGCAPTION',
]);

/**
 * Minimum text length for any captured line. Filters out nav crops
 * ("Read more", "Share", timestamps like "14 hrs ago") without
 * cutting legitimate paragraphs. ~30 char floor matches a short
 * sentence fragment.
 */
const MIN_TEXT_LEN = 30;

/**
 * Walk the winning node, emit text from each leaf-ish text container
 * (P/H1-H6/LI/PRE/BLOCKQUOTE/FIGCAPTION). Skip nav/header/footer/script
 * patterns.
 */
function extractProse(root: Element): string {
  const buf: string[] = [];
  const walk = (el: Element): void => {
    if (SKIP_TAGS.has(el.tagName)) return;
    const role = el.getAttribute('role');
    if (role && SKIP_ROLES.has(role)) return;

    if (TEXT_TAGS.has(el.tagName)) {
      // Element-class check: don't recurse text containers; their
      // text is already the merged content. (Nested H3 inside a
      // P shouldn't double-emit.)
      if (!el.querySelector('p, h1, h2, h3, h4, h5, h6, li, pre, blockquote')) {
        const text = (el.textContent ?? '').trim();
        if (text && text.length >= MIN_TEXT_LEN) buf.push(text);
        return;
      }
    }

    // Leaf-element fallback: prose that lives directly in a non-text
    // wrapper (e.g. <div>Some paragraph...</div>, scraped news pages,
    // certain React-rendered sites). el.children iterates Element
    // nodes only; without this, raw text children inside any wrapper
    // are silently lost.
    if (el.children.length === 0) {
      const text = (el.textContent ?? '').trim();
      if (text && text.length >= MIN_TEXT_LEN) buf.push(text);
      return;
    }

    for (const child of Array.from(el.children)) {
      walk(child as Element);
    }
  };
  walk(root);
  return buf.join('\n\n');
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

export function extractMainContent(root: Element = document.body): MainContent {
  const candidates: Candidate[] = [];
  const seen = new WeakSet<Element>();

  const consider = (el: Element): void => {
    if (seen.has(el)) return;
    seen.add(el);
    const { score, tags } = scoreCandidate(el);
    if (score <= 0) return;
    const selector = getNodeSelector(el);
    const preview =
      ((el.textContent ?? '').trim().slice(0, 200) + '…').trim();
    candidates.push({
      selector,
      title: extractTitle(el),
      preview,
      score,
      tags,
    });
  };

  // Pass 1: explicit semantic tags. Lowest friction, highest confidence.
  root
    .querySelectorAll('article, [role="article"], main, [role="main"]')
    .forEach(consider);

  // Pass 2: any large div/section that isn't nav-shaped. Catches
  // recipe blogs, forum threads, product descriptions that don't use
  // <article>.
  root.querySelectorAll('div, section').forEach((el) => {
    if (SKIP_TAGS.has(el.tagName)) return;
    const role = el.getAttribute('role');
    if (role && SKIP_ROLES.has(role)) return;
    consider(el);
  });

  if (candidates.length === 0) {
    return { title: '', prose: '', candidates: [], selected: -1 };
  }

  candidates.sort((a, b) => b.score - a.score);

  const winner = candidates[0];
  let winnerNode: Element | null = null;
  try {
    winnerNode = root.querySelector(winner.selector);
  } catch {
    winnerNode = null;
  }
  if (!winnerNode) {
    return { title: '', prose: '', candidates, selected: -1 };
  }

  const prose = extractProse(winnerNode);
  const title = extractTitle(winnerNode);

  return {
    title: title || winner.title,
    prose,
    candidates,
    selected: 0,
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
          `  #${i + 1} [${c.score.toFixed(3)}] ${c.selector}\n` +
            `     title: ${c.title || '(no title)'}\n` +
            `     preview: ${c.preview.slice(0, 120)}…\n` +
            `     tags: ${c.tags.join(', ') || '-'}`,
        );
      });
      // eslint-disable-next-line no-console
      console.log(
        `[Diamond] selected: #${result.selected + 1} "${result.title}" prose=${result.prose.length}ch`,
      );
      return result;
    };
  }
}
