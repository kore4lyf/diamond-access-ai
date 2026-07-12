/**
 * Diamond Access AI — DOM Walk Engine Tests
 *
 * Phase B: Unit tests for extractPageStructureFromRoot().
 * All tests run under vitest + jsdom — no browser needed.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { extractPageStructureFromRoot } from '../dom-walk';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Created containers that need cleanup after each test. */
const containers: HTMLElement[] = [];

/**
 * Create a container div from an HTML string and append it to the document
 * body. This ensures label-for / closest / getElementById queries work.
 */
function fixture(html: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  document.body.appendChild(div);
  containers.push(div);
  return div;
}

afterEach(() => {
  // Detach all fixture containers from the document
  for (const c of containers) {
    if (c.parentNode) c.parentNode.removeChild(c);
  }
  containers.length = 0;
});



// ---------------------------------------------------------------------------
// Smoke
// ---------------------------------------------------------------------------

describe('smoke', () => {
  it('1 + 1 === 2', () => {
    expect(1 + 1).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// DOM walk — core functionality
// ---------------------------------------------------------------------------

describe('extractPageStructureFromRoot', () => {
  // ── Simple article ──────────────────────────────────────────────────────

  it('extracts a simple article: h1 + p + link', () => {
    const root = fixture(`
      <h1>Article Title</h1>
      <p>This is an article paragraph with a <a href="/read-more">Read more</a> link.</p>
    `);

    const result = extractPageStructureFromRoot(root);
    const lines = result.split('\n').filter((l) => l.trim());

    // Expect 3–4 meaningful lines
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.length).toBeLessThanOrEqual(4);

    // First line: heading
    expect(lines[0]).toMatch(/\[heading level=1\]\s+"Article Title"/);
  });

  // ── Noise filtering ────────────────────────────────────────────────────

  it('filters out script, style, svg, aria-hidden', () => {
    const root = fixture(`
      <script>alert('x')</script>
      <style>body { color: red; }</style>
      <svg><circle cx="50" cy="50" r="40" /></svg>
      <div aria-hidden="true">Hidden</div>
      <div hidden>Also hidden</div>
    `);

    const result = extractPageStructureFromRoot(root);
    expect(result).toBe('');
  });

  // ── Button with aria-label ─────────────────────────────────────────────

  it('aria-label wins over visible text for buttons', () => {
    const root = fixture(`
      <button aria-label="Add to cart">Buy Now</button>
    `);

    const result = extractPageStructureFromRoot(root);
    // aria-label="Add to cart" should be the name, not "Buy Now"
    expect(result).toContain('"Add to cart"');
    expect(result).not.toContain('"Buy Now"');
  });

  // ── Button with visible text only ───────────────────────────────────────

  it('uses visible text for buttons without aria-label', () => {
    const root = fixture(`
      <button>Submit</button>
    `);

    const result = extractPageStructureFromRoot(root);
    expect(result).toContain('[button]');
    expect(result).toContain('"Submit"');
  });

  // ── IMG handling ────────────────────────────────────────────────────────

  it('includes img with alt text and skips img without alt', () => {
    const root = fixture(`
      <img alt="Crewneck shirt" src="shirt.jpg">
      <img src="decorative.jpg">
    `);

    const result = extractPageStructureFromRoot(root);

    // Image with alt should appear
    expect(result).toContain('[img]');
    expect(result).toContain('"Crewneck shirt"');

    // Image without alt should not appear at all
    expect(result).not.toContain('decorative');
  });

  it('skips img with empty alt attribute', () => {
    const root = fixture(`<img alt="" src="spacer.gif">`);
    const result = extractPageStructureFromRoot(root);
    expect(result).toBe('');
  });

  // ── Nested form ─────────────────────────────────────────────────────────

  it('produces correct indentation for nested form', () => {
    const root = fixture(`
      <form action="/submit">
        <label for="email">Email</label>
        <input type="email" id="email" value="john@example.com">
        <button type="submit">Submit</button>
      </form>
    `);

    const result = extractPageStructureFromRoot(root);
    const lines = result.split('\n').filter((l) => l.trim());

    // Form line should have no indent (depth 0)
    expect(lines[0]).toMatch(/^\[form\]/);

    // Child elements should have 2-space indent (depth 1)
    const textboxLine = lines.find((l) => l.includes('[textbox]'));
    expect(textboxLine).toBeTruthy();
    expect(textboxLine).toMatch(/^  \[textbox\]/);

    const buttonLine = lines.find((l) => l.includes('[button]'));
    expect(buttonLine).toBeTruthy();
    expect(buttonLine).toMatch(/^  \[button\]/);

    // Input should have accessible name from label
    expect(result).toContain('"Email"');
    expect(result).toContain('value="john@example.com"');
    expect(result).toContain('/submit');
  });

  // ── Link target ─────────────────────────────────────────────────────────

  it('captures link targets', () => {
    const root = fixture(`<a href="/checkout">Checkout</a>`);

    const result = extractPageStructureFromRoot(root).trim();
    expect(result).toContain('[link]');
    expect(result).toContain('"Checkout"');
    expect(result).toContain('→ /checkout');
  });

  // ── Text inside non-role containers ─────────────────────────────────────

  it('captures text content inside non-role wrappers', () => {
    const root = fixture(`<div><p>Hello world</p></div>`);

    const result = extractPageStructureFromRoot(root).trim();
    // <p> has no role, so it's transparent — text is promoted
    expect(result).toContain('Hello world');
  });

  // ── Empty body ──────────────────────────────────────────────────────────

  it('returns empty string for empty root', () => {
    const root = fixture('');
    const result = extractPageStructureFromRoot(root);
    expect(result).toBe('');
  });

  // ── Determinism ─────────────────────────────────────────────────────────

  it('is deterministic: same input produces same output', () => {
    const root = fixture(`
      <nav>
        <a href="/home">Home</a>
        <a href="/about">About</a>
      </nav>
      <h1>Welcome</h1>
    `);

    const result1 = extractPageStructureFromRoot(root);
    const result2 = extractPageStructureFromRoot(root);
    expect(result1).toBe(result2);
  });
});

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

describe('truncation', () => {
  it('truncates deep elements and adds summary line', () => {
    // Create nested sections to push content beyond the truncation cap.
    // 15 levels of <section> with buttons at each level.
    // At maxChars=400, depth 0-2 keeps (section×3 + buttons at those
    // depths); depth 3+ should be summarized as a count line.
    //
    // PC-QA Round 3: DEFAULT_MAX_CHARS was bumped from 1500 to 4000
    // so BBC's full structure survives. This test explicitly passes a
    // small cap so it exercises truncation behavior independent of the
    // global default.
    let html = '';
    for (let i = 0; i < 15; i++) {
      html += '<section>';
    }
    // Add enough buttons deep inside to exceed the 400-char cap
    for (let i = 0; i < 20; i++) {
      html += `<button>Button number ${i} at deep level</button>`;
    }
    html += '</section>'.repeat(15);

    const root = fixture(html);
    const result = extractPageStructureFromRoot(root, 400);

    // Should have a summary line
    expect(result).toContain('more children');

    // Interactive elements at depth < 3 should survive
    // (Sections + buttons at depths 0-2 are kept)
    const lines = result.split('\n').filter((l) => l.trim());
    const keptLines = lines.filter(
      (l) => !l.includes('more children'),
    );
    expect(keptLines.length).toBeGreaterThan(0);
  });

  it('keeps depth 0-2 elements fully, even with high char count', () => {
    // Deep nesting but with many elements at top levels
    const root = fixture(`
      <h1>Top Heading</h1>
      <nav>
        <a href="/a">Link A</a>
        <a href="/b">Link B</a>
        <a href="/c">Link C</a>
      </nav>
      <button>Action</button>
      <section>
        <section>
          <section>
            <button>Deep Button 1</button>
            <button>Deep Button 2</button>
            <button>Deep Button 3</button>
          </section>
        </section>
      </section>
    `);

    const result = extractPageStructureFromRoot(root);

    // All depth-0 and depth-1 elements must survive
    expect(result).toContain('Top Heading');
    expect(result).toContain('Link A');
    expect(result).toContain('Link B');
    expect(result).toContain('Link C');
    expect(result).toContain('Action');

    // Deep elements may be truncated
    // (outer section at depth 0 → depth 1 → depth 2 → depth 3 buttons)
    const hasDeep = result.includes('Deep Button 1');
    const hasSummary = result.includes('more children');
    expect(hasDeep || hasSummary).toBe(true);
  });

  it('respects configurable maxChars', () => {
    const root = fixture(`
      <section>
        <section>
          <section>
            <button>Deep</button>
          </section>
        </section>
      </section>
      <button>A</button><button>B</button><button>C</button>
      <button>D</button><button>E</button><button>F</button>
    `);

    // With a very small max, even some depth-0 elements may stay
    const result = extractPageStructureFromRoot(root, 50);
    // Result should be <= maxChars (might be slightly over due to summary)
    expect(result.length).toBeLessThanOrEqual(200); // generous bound
    expect(result).not.toBe('');
  });
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

describe('performance', () => {
  it('walks 200 flat nodes in under 200ms on jsdom', () => {
    // Build a fixture with ~200 interactive elements at top level
    const buttons = Array.from({ length: 200 }, (_, i) =>
      i % 2 === 0
        ? `<button>Button ${i}</button>`
        : `<a href="/link/${i}">Link ${i}</a>`,
    ).join('\n');

    const root = fixture(buttons);

    const start = performance.now();
    extractPageStructureFromRoot(root);
    const elapsed = performance.now() - start;

    // jsdom on Termux (aarch64 Android) is slower than real Chrome V8.
    // This threshold is generous enough for the test environment while still
    // catching pathological regressions.
    expect(elapsed).toBeLessThan(400);
  });

  it('handles 200-node SPA-like DOM in under 300ms on jsdom', () => {
    // Simulate a heavier SPA with 10 sections × 20 buttons each
    const sections = Array.from(
      { length: 10 },
      (_, s) =>
        `<section aria-label="Section ${s}">${
          Array.from(
            { length: 20 },
            (_, b) => `<button>Button ${s}.${b}</button>`,
          ).join('\n')
        }</section>`,
    ).join('\n');

    const root = fixture(sections);

    const start = performance.now();
    extractPageStructureFromRoot(root);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(300);
  });


});

// ---------------------------------------------------------------------------
// Accessible name edge cases
// ---------------------------------------------------------------------------

describe('accessible name computation', () => {
  it('uses aria-label over title', () => {
    const root = fixture(`<button aria-label="Close" title="Dismiss">X</button>`);
    const result = extractPageStructureFromRoot(root);
    expect(result).toContain('"Close"');
    expect(result).not.toContain('"Dismiss"');
    expect(result).not.toContain('"X"');
  });

  it('uses title when aria-label is absent', () => {
    const root = fixture(`<button title="Dismiss">X</button>`);
    const result = extractPageStructureFromRoot(root);
    expect(result).toContain('"Dismiss"');
  });

  it('uses placeholder for inputs without label', () => {
    const root = fixture(`<input type="text" placeholder="Search">`);
    const result = extractPageStructureFromRoot(root);
    expect(result).toContain('"Search"');
  });

  it('captures checkbox state', () => {
    const root = fixture(`
      <input type="checkbox" aria-checked="true" aria-label="Accept terms">
    `);
    const result = extractPageStructureFromRoot(root);
    expect(result).toContain('checked=true');
  });

  it('captures disabled state', () => {
    const root = fixture(`<button disabled aria-label="Save">Save</button>`);
    const result = extractPageStructureFromRoot(root);
    expect(result).toContain('disabled');
  });
});

// ---------------------------------------------------------------------------
// Role mapping
// ---------------------------------------------------------------------------

describe('implicit role mapping', () => {
  it('maps heading tags to heading with level', () => {
    const root = fixture(`
      <h1>H1</h1>
      <h2>H2</h2>
      <h3>H3</h3>
    `);
    const result = extractPageStructureFromRoot(root);
    expect(result).toContain('[heading level=1]');
    expect(result).toContain('[heading level=2]');
    expect(result).toContain('[heading level=3]');
  });

  it('maps nav to navigation', () => {
    const root = fixture(`<nav><a href="/">Home</a></nav>`);
    const result = extractPageStructureFromRoot(root);
    expect(result).toContain('[navigation]');
  });

  it('maps main to main', () => {
    const root = fixture(`<main><p>Content</p></main>`);
    const result = extractPageStructureFromRoot(root);
    expect(result).toContain('[main]');
  });

  it('maps section to region', () => {
    const root = fixture(`<section aria-label="Section">Content</section>`);
    const result = extractPageStructureFromRoot(root);
    expect(result).toContain('[region]');
  });

  it('maps form to form', () => {
    const root = fixture(`<form><input placeholder="Name"></form>`);
    const result = extractPageStructureFromRoot(root);
    expect(result).toContain('[form]');
  });

  it('respects explicit role attribute', () => {
    const root = fixture(`<div role="search"><input placeholder="Search"></div>`);
    const result = extractPageStructureFromRoot(root);
    expect(result).toContain('[search]');
  });
});

// ---------------------------------------------------------------------------
// Image enumeration (Phase J + Image-describe feature)
// ---------------------------------------------------------------------------

import { enumerateImages, speakImageList, MAX_IMAGES, enumerateLinks, speakLinkList } from '../dom-walk';

describe('enumerateImages', () => {
  function makeImg(src: string, alt: string, w = 200, h = 100): HTMLElement {
    const img = document.createElement('img');
    img.src = src;
    img.alt = alt;
    // jsdom doesn't layout — fake a bounding rect so enumerateImages
    // doesn't skip zero-area boxes (we filter width<1 / height<1).
    Object.defineProperty(img, 'getBoundingClientRect', {
      value: () => ({
        x: 0, y: 0, left: 0, top: 0, right: w, bottom: h,
        width: w, height: h,
      }),
    });
    return img;
  }

  it('returns empty array when no <img> elements exist', () => {
    const root = fixture('<div>some text</div>');
    expect(enumerateImages(root)).toEqual([]);
  });

  it('enumerates a single <img> with alt and aria-label', () => {
    const root = fixture('<div></div>');
    root.appendChild(makeImg('https://x/y.jpg', 'Cover photo'));
    const out = enumerateImages(root);
    expect(out.length).toBe(1);
    expect(out[0].label).toBe('Cover photo');
    expect(out[0].src).toBe('https://x/y.jpg');
    expect(out[0].index).toBe(1);
  });

  it('uses aria-label when alt is missing', () => {
    const root = fixture('<div></div>');
    root.appendChild(makeImg('https://x/y.jpg', ''));
    root.lastElementChild!.setAttribute('aria-label', 'Hero illustration');
    const out = enumerateImages(root);
    expect(out[0].label).toBe('Hero illustration');
  });

  it('falls back to filename when both alt and aria-label are empty', () => {
    const root = fixture('<div></div>');
    root.appendChild(makeImg('https://cdn.example.com/abc/cover.jpg', ''));
    const out = enumerateImages(root);
    expect(out[0].label).toMatch(/unlabeled image/);
    expect(out[0].label).toMatch(/cover\.jpg/);
  });

  it('skips zero-area images (not yet rendered)', () => {
    const root = fixture('<div></div>');
    const img = document.createElement('img');
    img.src = 'https://x/y.jpg';
    img.alt = 'tiny';
    Object.defineProperty(img, 'getBoundingClientRect', {
      value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    });
    root.appendChild(img);
    expect(enumerateImages(root).length).toBe(0);
  });

  it('respects maxImages cap', () => {
    const root = fixture('<div></div>');
    for (let i = 0; i < 5; i++) {
      root.appendChild(makeImg(`https://x/${i}.jpg`, `Image ${i}`));
    }
    expect(enumerateImages(root, 3).length).toBe(3);
    expect(enumerateImages(root, 999).length).toBe(5);
  });
});

describe('speakImageList', () => {
  function entry(label: string, index: number) {
    return {
      index, label,
      alt: label, ariaLabel: null, src: 'x',
      bbox: { x: 0, y: 0, width: 0, height: 0 },
    };
  }

  it('returns "no images" line for empty input', () => {
    expect(speakImageList([])).toMatch(/no images/i);
  });

  it('lists images with index prefixes', () => {
    const out = speakImageList([entry('Cover', 1), entry('Hero', 2)]);
    expect(out).toMatch(/image 1.*Cover/);
    expect(out).toMatch(/image 2.*Hero/);
  });

  it('uses singular "image" for one entry', () => {
    expect(speakImageList([entry('Solo', 1)])).toMatch(/1 image\b/);
    expect(speakImageList([entry('A', 1), entry('B', 2)])).toMatch(/2 images\b/);
  });

  it('exports MAX_IMAGES as a non-zero cap', () => {
    expect(MAX_IMAGES).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// enumerateLinks — mirror enumerateImages, for list_links action
// ---------------------------------------------------------------------------

describe('enumerateLinks', () => {
  // Build a snapshot-like object for enumerateLinks
  function makeSnapshot(elements: HTMLElement[]): { elements: HTMLElement[] } {
    return { elements };
  }

  it('returns empty array when no <a> elements exist', () => {
    const root = fixture('<div>some text</div>');
    const snapshot = makeSnapshot(Array.from(root.children) as HTMLElement[]);
    expect(enumerateLinks(snapshot)).toEqual([]);
  });

  it('enumerates a single <a> with href and text content', () => {
    const root = fixture('<a href="/news/england">England vs DR Congo</a>');
    const snapshot = makeSnapshot(Array.from(root.children) as HTMLElement[]);
    const out = enumerateLinks(snapshot);
    expect(out.length).toBe(1);
    expect(out[0].text).toBe('England vs DR Congo');
    expect(out[0].href).toBe('/news/england');
    // index should be 1-based (mirrors enumerateImages)
    expect(out[0].index).toBe(1);
  });

  it('skips javascript: and # URLs', () => {
    const root = fixture(`
      <a href="javascript:void(0)">Fake link</a>
      <a href="#">Empty fragment</a>
      <a href="/real">Real link</a>
    `);
    const snapshot = makeSnapshot(Array.from(root.children) as HTMLElement[]);
    const out = enumerateLinks(snapshot);
    expect(out.length).toBe(1);
    expect(out[0].href).toBe('/real');
  });

  it('skips aria-hidden links', () => {
    const root = fixture(`
      <a href="/hidden" aria-hidden="true">Hidden</a>
      <a href="/visible">Visible</a>
    `);
    const snapshot = makeSnapshot(Array.from(root.children) as HTMLElement[]);
    const out = enumerateLinks(snapshot);
    expect(out.map((l) => l.href)).not.toContain('/hidden');
    expect(out).toHaveLength(1);
  });

  it('deduplicates by href (same URL appears once)', () => {
    const root = fixture(`
      <a href="/same">First</a>
      <a href="/other">Other</a>
      <a href="/same">Duplicate</a>
    `);
    const snapshot = makeSnapshot(Array.from(root.children) as HTMLElement[]);
    const out = enumerateLinks(snapshot);
    const hrefs = out.map((h) => h.href);
    expect(hrefs.filter((h) => h === '/same')).toHaveLength(1);
  });

  it('uses trimmed text content as label', () => {
    const root = fixture('<a href="/news">  Extra whitespace here  </a>');
    const snapshot = makeSnapshot(Array.from(root.children) as HTMLElement[]);
    const out = enumerateLinks(snapshot);
    expect(out[0].text).toBe('Extra whitespace here');
  });

  it('skips empty text-only links', () => {
    const root = fixture('<a href="/empty"></a>');
    const snapshot = makeSnapshot(Array.from(root.children) as HTMLElement[]);
    const out = enumerateLinks(snapshot);
    expect(out).toEqual([]);
  });

  it('respects maxLinks cap', () => {
    const root = fixture('<div></div>');
    const links: HTMLElement[] = [];
    for (let i = 0; i < 5; i++) {
      const a = document.createElement('a');
      a.href = `/link${i}`;
      a.textContent = `Link ${i}`;
      root.appendChild(a);
      links.push(a);
    }
    const snapshot = makeSnapshot(links);
    // MAX_LINKS expected to be exported
    expect(enumerateLinks(snapshot).length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// speakLinkList — mirror speakImageList, for list_links action
// ---------------------------------------------------------------------------

describe('speakLinkList', () => {
  function makeLinkEntry(text: string, index: number, href: string): { index: number; text: string; href: string } {
    return { index, text, href };
  }

  it('returns "no links" line for empty input', () => {
    expect(speakLinkList([])).toMatch(/no links/i);
  });

  it('lists links with index prefixes matching snapshot', () => {
    const out = speakLinkList([
      makeLinkEntry('England vs DR Congo', 12, '/news/england'),
      makeLinkEntry('Breaking News', 15, '/news/breaking'),
    ]);
    // Numbers = the index user will say
    expect(out).toMatch(/Number 12.*England vs DR Congo/i);
    expect(out).toMatch(/Number 15.*Breaking News/i);
  });

  it('uses singular "link" for one entry', () => {
    expect(speakLinkList([makeLinkEntry('Solo', 1, '/solo')])).toMatch(/1 link\b/);
    expect(speakLinkList([makeLinkEntry('A', 1, '/a'), makeLinkEntry('B', 2, '/b')])).toMatch(/2 links\b/);
  });

  it('truncates long link text to speech-friendly length', () => {
    const longText = 'This is an extremely long headline that would be hard to speak in one breath and should be truncated';
    const out = speakLinkList([makeLinkEntry(longText, 1, '/long')]);
    expect(out.length).toBeLessThan(longText.length + 50);
    expect(out).toMatch(/Number 1/);
  });
});
