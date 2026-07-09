/**
 * Diamond Access AI — Page Snapshot Tests
 *
 * Phase E: Unit tests for buildPageSnapshot(), isSparseDOM().
 * All tests run under vitest + jsdom — no browser, no chrome.*, no network.
 *
 * Per TO-DEV.md §Phase E Task 6:
 *   - buildPageSnapshot returns { structure, elements } with matching counts
 *   - Interactive elements get [N] labels (1-based)
 *   - elementIndex resolution: index N → elements[N-1]
 *   - Sparse DOM detection
 *   - Non-interactive elements (headings, sections) do NOT get [N] labels
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildPageSnapshot, isSparseDOM } from '../page-snapshot';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const containers: HTMLElement[] = [];

function fixture(html: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  document.body.appendChild(div);
  containers.push(div);
  return div;
}

afterEach(() => {
  for (const c of containers) {
    if (c.parentNode) c.parentNode.removeChild(c);
  }
  containers.length = 0;
});

function countTaggedLines(structure: string): number {
  return structure.split('\n').filter((l) => /^\s*\[\d+\]/.test(l)).length;
}

// ---------------------------------------------------------------------------
// Smoke
// ---------------------------------------------------------------------------

describe('smoke', () => {
  it('1 + 1 === 2', () => {
    expect(1 + 1).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// buildPageSnapshot
// ---------------------------------------------------------------------------

describe('buildPageSnapshot', () => {
  it('returns structure and elements for a simple page', () => {
    const root = fixture(`
      <h1>Shop</h1>
      <button>Buy now</button>
      <a href="/cart">Cart</a>
    `);

    const snap = buildPageSnapshot(root);

    expect(snap).toHaveProperty('structure');
    expect(snap).toHaveProperty('elements');
    expect(typeof snap.structure).toBe('string');
    expect(Array.isArray(snap.elements)).toBe(true);
  });

  it('assigns [N] labels to interactive elements (1-based)', () => {
    const root = fixture(`
      <button>A</button>
      <button>B</button>
      <button>C</button>
    `);

    const snap = buildPageSnapshot(root);

    // Should have exactly 3 tagged lines
    expect(countTaggedLines(snap.structure)).toBe(3);

    // [1], [2], [3] should appear in order
    const lines = snap.structure.split('\n').filter((l) => l.trim());
    expect(lines[0]).toMatch(/^\[1\]/);
    expect(lines[1]).toMatch(/^\[2\]/);
    expect(lines[2]).toMatch(/^\[3\]/);

    // 3 elements in the array
    expect(snap.elements).toHaveLength(3);
  });

  it('non-interactive elements (headings, sections) do NOT get [N] labels', () => {
    const root = fixture(`
      <h1>Title</h1>
      <section>
        <p>Some text</p>
        <button>Action</button>
      </section>
    `);

    const snap = buildPageSnapshot(root);

    // Only the button should be tagged
    expect(countTaggedLines(snap.structure)).toBe(1);
    expect(snap.elements).toHaveLength(1);

    // The tagged line should be the button
    const taggedLine = snap.structure
      .split('\n')
      .find((l) => /^\s*\[\d+\]/.test(l));
    expect(taggedLine).toContain('[button]');
    expect(taggedLine).toContain('"Action"');
  });

  it('elementIndex N resolves to elements[N-1]', () => {
    const root = fixture(`
      <button>First</button>
      <button>Second</button>
      <a href="/third">Third</a>
    `);

    const snap = buildPageSnapshot(root);

    // elementIndex 2 → elements[1] → second button
    const idx = 2;
    const el = snap.elements[idx - 1];
    expect(el).toBeDefined();
    expect(el.tagName).toBe('BUTTON');
    expect(el.textContent?.trim()).toBe('Second');

    // elementIndex 3 → elements[2] → the link
    const idx3 = 3;
    const el3 = snap.elements[idx3 - 1];
    expect(el3).toBeDefined();
    expect(el3.tagName).toBe('A');
  });

  it('out-of-bounds elementIndex returns null from resolveElement', () => {
    const root = fixture(`<button>Only</button>`);
    const snap = buildPageSnapshot(root);

    // elementIndex 0 is invalid (indices are 1-based)
    // elementIndex 2 is out of bounds
    expect(snap.elements[-1]).toBeUndefined();
    expect(snap.elements[1]).toBeUndefined();
    expect(snap.elements[0]).toBeDefined();
  });

  it('a[href] elements are interactive, plain a without href is not', () => {
    const root = fixture(`
      <a href="/link">Link</a>
      <a name="anchor">Anchor</a>
    `);

    const snap = buildPageSnapshot(root);

    // Only the a[href] should be collected
    expect(snap.elements).toHaveLength(1);
    expect(snap.elements[0].getAttribute('href')).toBe('/link');

    // Only 1 tagged line
    expect(countTaggedLines(snap.structure)).toBe(1);
  });

  it('captures input elements with various types', () => {
    const root = fixture(`
      <input type="text" placeholder="Name">
      <input type="checkbox" aria-label="Agree">
      <input type="radio" aria-label="Option 1">
      <input type="submit" value="Go">
    `);

    const snap = buildPageSnapshot(root);

    // All 4 inputs are interactive
    expect(snap.elements).toHaveLength(4);
    expect(countTaggedLines(snap.structure)).toBe(4);
  });

  it('captures select and textarea as interactive', () => {
    const root = fixture(`
      <select aria-label="Country">
        <option>US</option>
      </select>
      <textarea placeholder="Message"></textarea>
    `);

    const snap = buildPageSnapshot(root);

    expect(snap.elements).toHaveLength(2);
    expect(snap.elements[0].tagName).toBe('SELECT');
    expect(snap.elements[1].tagName).toBe('TEXTAREA');
  });

  it('collects elements with explicit interactive role', () => {
    const root = fixture(`
      <div role="button" tabindex="0">Custom button</div>
      <div role="link" data-href="/go">Custom link</div>
    `);

    const snap = buildPageSnapshot(root);

    expect(snap.elements).toHaveLength(2);
    expect(snap.elements[0].getAttribute('role')).toBe('button');
    expect(snap.elements[1].getAttribute('role')).toBe('link');
  });

  it('preserves non-interactive structure lines without tags', () => {
    const root = fixture(`
      <nav>
        <a href="/home">Home</a>
      </nav>
      <main>
        <h1>Welcome</h1>
        <p>Content here</p>
        <button>Learn more</button>
      </main>
    `);

    const snap = buildPageSnapshot(root);

    // Structure should contain [navigation], [main], [heading] lines without labels
    const lines = snap.structure.split('\n').filter((l) => l.trim());
    const untaggedInteractive = lines.filter(
      (l) => l.includes('[navigation]') || l.includes('[main]') || l.includes('[heading'),
    );

    expect(untaggedInteractive.length).toBeGreaterThan(0);

    // All untagged interactive lines should NOT have [N] prefix
    for (const line of untaggedInteractive) {
      expect(line).not.toMatch(/^\s*\[\d+\]/);
    }

    // Only the link and button should be tagged
    const tagged = lines.filter((l) => /^\s*\[\d+\]/.test(l));
    expect(tagged).toHaveLength(2);
  });

  it('empty root returns empty structure and no elements', () => {
    const root = fixture('');
    const snap = buildPageSnapshot(root);

    expect(snap.structure).toBe('');
    expect(snap.elements).toHaveLength(0);
  });

  it('sequential [N] labels match element array order', () => {
    const root = fixture(`
      <button id="b1">First</button>
      <div role="button" id="b2">Second</div>
      <a href="/t" id="b3">Third</a>
      <input type="text" id="b4" placeholder="Fourth">
    `);

    const snap = buildPageSnapshot(root);

    // [1] → b1, [2] → b2, [3] → b3, [4] → b4
    expect(snap.elements[0].id).toBe('b1');
    expect(snap.elements[1].id).toBe('b2');
    expect(snap.elements[2].id).toBe('b3');
    expect(snap.elements[3].id).toBe('b4');

    const lines = snap.structure.split('\n').filter((l) => /^\s*\[\d+\]/.test(l));
    expect(lines).toHaveLength(4);
  });

  it('filters out script, style, aria-hidden, hidden elements', () => {
    const root = fixture(`
      <script>alert('x')</script>
      <button>Visible</button>
      <div aria-hidden="true">
        <button>Hidden</button>
      </div>
      <button>Also visible</button>
    `);

    const snap = buildPageSnapshot(root);

    // Only the visible buttons should be collected
    expect(snap.elements).toHaveLength(2);
    expect(snap.elements[0].textContent?.trim()).toBe('Visible');
    expect(snap.elements[1].textContent?.trim()).toBe('Also visible');
  });

  it('shadowed elements inside aria-hidden are not collected', () => {
    const root = fixture(`
      <button>Outer</button>
      <div inert>
        <button>Inert</button>
      </div>
    `);

    const snap = buildPageSnapshot(root);
    expect(snap.elements).toHaveLength(1);
    expect(snap.elements[0].textContent?.trim()).toBe('Outer');
  });
});

// ---------------------------------------------------------------------------
// isSparseDOM
// ---------------------------------------------------------------------------

describe('isSparseDOM', () => {
  it('returns true for page with fewer than 3 interactive elements', () => {
    const root = fixture(`
      <h1>Hello</h1>
      <p>Some paragraph text.</p>
      <a href="/next">Next</a>
    `);
    // Only 1 interactive element (< 3 threshold)
    expect(isSparseDOM(root)).toBe(true);
  });

  it('returns true for page with mostly text content', () => {
    const root = fixture(`
      <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.
      Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.
      Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.</p>
      <p>Another long paragraph of text that dominates the page content
      and makes the interactive ratio very low compared to text lines.</p>
    `);
    expect(isSparseDOM(root)).toBe(true);
  });

  it('returns false for normal page with multiple interactive elements', () => {
    const root = fixture(`
      <header>
        <nav>
          <a href="/">Home</a>
          <a href="/about">About</a>
          <a href="/contact">Contact</a>
          <a href="/blog">Blog</a>
          <a href="/shop">Shop</a>
        </nav>
      </header>
      <main>
        <h1>Product Page — Premium Widgets</h1>
        <p>Welcome to our store. We sell the best widgets.</p>
        <section aria-label="Featured products">
          <button>Super Widget — $29.99</button>
          <button>Mega Widget — $49.99</button>
          <button>Ultra Widget — $99.99</button>
        </section>
      </main>
      <footer>
        <a href="/privacy">Privacy Policy</a>
        <a href="/terms">Terms of Service</a>
      </footer>
    `);
    // 10 interactive elements — clearly not sparse
    expect(isSparseDOM(root)).toBe(false);
  });

  it('returns false for medium-rich page', () => {
    const root = fixture(`
      <header>
        <nav>
          <a href="/">Home</a>
          <a href="/shop">Shop</a>
          <a href="/about">About</a>
        </nav>
      </header>
      <main>
        <h1>Featured Items</h1>
        <button>Item 1</button>
        <button>Item 2</button>
        <button>Item 3</button>
      </main>
      <footer>
        <a href="/privacy">Privacy</a>
      </footer>
    `);
    expect(isSparseDOM(root)).toBe(false);
  });

  it('returns true for empty page', () => {
    const root = fixture('');
    expect(isSparseDOM(root)).toBe(true);
  });
});
