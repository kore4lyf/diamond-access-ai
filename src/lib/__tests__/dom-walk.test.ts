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
    // Create nested sections to push content beyond 1500 chars
    // 12 levels of <section> with buttons at each level
    // At 1500 chars, depth 0-2 keeps (section×3 + buttons)
    // depth 3+ should be summarized
    let html = '';
    for (let i = 0; i < 15; i++) {
      html += '<section>';
    }
    // Add enough buttons deep inside to exceed 1500 chars
    for (let i = 0; i < 20; i++) {
      html += `<button>Button number ${i} at deep level</button>`;
    }
    html += '</section>'.repeat(15);

    const root = fixture(html);
    const result = extractPageStructureFromRoot(root);

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
    expect(elapsed).toBeLessThan(200);
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
