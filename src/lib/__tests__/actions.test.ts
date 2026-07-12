/**
 * Diamond Access AI — Action Execution Engine Tests
 *
 * Phase F: Unit tests for clickAction, navigateAction, fillAction,
 * selectOption, detectSensitiveType, confirmAction, checkConfirmation,
 * executeAction dispatcher, and error paths.
 *
 * All tests run under vitest + jsdom — no browser, no chrome.*, no network.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  executeAction,
  clickAction,
  navigateAction,
  fillAction,
  selectOption,
  detectSensitiveType,
  confirmAction,
  checkConfirmation,
  hasPendingConfirm,
  listImagesAction,
  type DiamondAction,
} from '../actions';
import type { PageSnapshot } from '../page-snapshot';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const containers: HTMLElement[] = [];

/** Create a DOM fixture and return the container div. */
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

/** Build a minimal PageSnapshot from individual elements. */
function makeSnapshot(elements: HTMLElement[]): PageSnapshot {
  return {
    structure: elements
      .map((el, i) => `[${i + 1}] ${el.tagName} "${el.textContent?.trim() ?? ''}"`)
      .join('\n'),
    elements,
  };
}

/** Spy on an element method and return the spy. */
function spyOnMethod<K extends keyof HTMLElement>(
  el: HTMLElement,
  method: K,
) {
  return vi.spyOn(el, method as never);
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
// clickAction
// ---------------------------------------------------------------------------

describe('clickAction', () => {
  it('resolves elementIndex and calls click()', () => {
    const btn = document.createElement('button');
    btn.textContent = 'Buy now';
    const snap = makeSnapshot([btn]);
    const clickSpy = spyOnMethod(btn, 'click');

    const result = clickAction(1, snap, 'Clicking Buy now');

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe('Clicking Buy now');
  });

  it('scrolls element into view before clicking', () => {
    const btn = document.createElement('button');
    btn.textContent = 'Scroll me';
    // jsdom doesn't define scrollIntoView on HTMLElement — stub it first
    btn.scrollIntoView = (() => {}) as typeof btn.scrollIntoView;
    const snap = makeSnapshot([btn]);
    const scrollSpy = spyOnMethod(btn, 'scrollIntoView');

    clickAction(1, snap, 'Clicking');

    expect(scrollSpy).toHaveBeenCalledWith({
      behavior: 'instant',
      block: 'center',
    });
  });

  it('out-of-range elementIndex returns error string', () => {
    const snap = makeSnapshot([document.createElement('button')]);

    const result = clickAction(99, snap, 'Nowhere');

    expect(result).toContain("couldn't find that element");
  });

  it('single-element array, index 2 returns error', () => {
    const btn = document.createElement('div');
    const snap = makeSnapshot([btn]);

    const result = clickAction(2, snap, 'test');
    expect(result).toContain("couldn't find");
  });

  it('dispatches MouseEvent for non-standard clickable elements', () => {
    const div = document.createElement('div');
    div.setAttribute('role', 'button');
    div.textContent = 'Custom';
    const snap = makeSnapshot([div]);
    const dispatchSpy = vi.spyOn(div, 'dispatchEvent');

    clickAction(1, snap, 'Clicking custom');

    // Should have at least been dispatched a MouseEvent
    const mouseEventCalls = dispatchSpy.mock.calls.filter(
      (args: unknown[]) => args[0] instanceof MouseEvent,
    );
    expect(mouseEventCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('works with elementIndex > 1', () => {
    const b1 = document.createElement('button');
    b1.textContent = 'First';
    const b2 = document.createElement('button');
    b2.textContent = 'Second';
    const snap = makeSnapshot([b1, b2]);

    const clickSpy = spyOnMethod(b2, 'click');
    clickAction(2, snap, 'Clicking second');

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// navigateAction
// ---------------------------------------------------------------------------

describe('navigateAction', () => {
  beforeEach(() => {
    // Set a predictable origin for tests
    vi.stubGlobal('window', {
      ...window,
      location: { ...window.location, origin: 'https://example.com', href: 'https://example.com/' },
      open: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('javascript: URLs are refused', () => {
    const result = navigateAction('javascript:alert("xss")');
    expect(result).toContain("can't navigate to that type of URL");
  });

  it('resolves relative URLs against origin', () => {
    // Mock location.origin
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://example.com', href: 'https://example.com/' },
      writable: true,
    });

    // navigateAction sets location.href — need to allow it
    const originalLocation = window.location;
    const mockLocation = { ...originalLocation, origin: 'https://example.com', href: 'https://example.com/' };
    Object.defineProperty(window, 'location', {
      value: mockLocation,
      writable: true,
    });

    navigateAction('/checkout');
    expect(mockLocation.href).toBe('https://example.com/checkout');
  });

  it('opens cross-origin URLs in new tab', () => {
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://example.com', href: 'https://example.com/' },
      writable: true,
    });
    const openSpy = vi.fn();
    vi.stubGlobal('window', { ...window, open: openSpy });

    navigateAction('https://other-site.com/page');
    expect(openSpy).toHaveBeenCalledWith('https://other-site.com/page', '_blank');
  });

  it('returns error string when navigation is blocked (cross-origin)', () => {
    // For same-origin, setting location.href doesn't throw; for cross-origin,
    // window.open might return null in restricted environments.
    // We test the error path by making window.open throw
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://example.com' },
      writable: true,
    });
    vi.stubGlobal('window', {
      ...window,
      open: vi.fn(() => { throw new Error('Blocked'); }),
    });

    // We need navigateAction to actually enter the cross-origin path
    // by overriding window.location.origin
    const result = navigateAction('https://other.com');
    expect(result).toContain("couldn't navigate");
  });
});

// ---------------------------------------------------------------------------
// fillAction
// ---------------------------------------------------------------------------

describe('fillAction', () => {
  it('fills input using nativeInputValueSetter and dispatches events', async () => {
    const input = document.createElement('input');
    input.type = 'text';
    const snap = makeSnapshot([input]);
    const dispatchSpy = vi.spyOn(input, 'dispatchEvent');

    const result = await fillAction(
      [{ elementIndex: 1, value: 'hello@example.com' }],
      snap,
      'Filling email',
    );

    expect(result).toBe('Filling email');
    expect(input.value).toBe('hello@example.com');

    // Should have dispatched input, change, and blur
    const eventTypes = dispatchSpy.mock.calls.map(
      (args: unknown[]) => (args[0] as Event).type,
    );
    expect(eventTypes).toContain('input');
    expect(eventTypes).toContain('change');
    expect(eventTypes).toContain('blur');
  });

  it('fills multiple fields', async () => {
    const input1 = document.createElement('input');
    input1.type = 'text';
    const input2 = document.createElement('input');
    input2.type = 'text';
    const snap = makeSnapshot([input1, input2]);

    const result = await fillAction(
      [
        { elementIndex: 1, value: 'John' },
        { elementIndex: 2, value: 'Doe' },
      ],
      snap,
      'Filling name',
    );

    expect(result).toBe('Filling name');
    expect(input1.value).toBe('John');
    expect(input2.value).toBe('Doe');
  });

  it('returns error for read-only field', async () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.readOnly = true;
    const snap = makeSnapshot([input]);

    const result = await fillAction(
      [{ elementIndex: 1, value: 'test' }],
      snap,
      'Filling',
    );

    expect(result).toContain("couldn't fill");
  });

  it('returns error for disabled field', async () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.disabled = true;
    const snap = makeSnapshot([input]);

    const result = await fillAction(
      [{ elementIndex: 1, value: 'test' }],
      snap,
      'Filling',
    );

    expect(result).toContain("couldn't fill");
  });

  it('returns error for out-of-range elementIndex', async () => {
    const snap = makeSnapshot([document.createElement('input')]);

    const result = await fillAction(
      [{ elementIndex: 99, value: 'test' }],
      snap,
      'Filling',
    );

    expect(result).toContain("couldn't find");
  });

  it('fills textarea elements', async () => {
    const ta = document.createElement('textarea');
    const snap = makeSnapshot([ta]);

    await fillAction(
      [{ elementIndex: 1, value: 'long text here' }],
      snap,
      'Filling description',
    );

    expect(ta.value).toBe('long text here');
  });

  it('fills select with matching option', async () => {
    const sel = document.createElement('select');
    sel.innerHTML = `
      <option value="us">United States</option>
      <option value="ng">Nigeria</option>
      <option value="uk">United Kingdom</option>
    `;
    const snap = makeSnapshot([sel]);

    const result = await fillAction(
      [{ elementIndex: 1, value: 'Nigeria' }],
      snap,
      'Selecting country',
    );

    expect(result).toBe('Selecting country');
    expect(sel.value).toBe('ng');
  });

  it('fills select by value when text does not match', async () => {
    const sel = document.createElement('select');
    sel.innerHTML = `
      <option value="us">United States</option>
      <option value="ng">Nigeria</option>
    `;
    const snap = makeSnapshot([sel]);

    await fillAction(
      [{ elementIndex: 1, value: 'ng' }],
      snap,
      '',
    );

    expect(sel.value).toBe('ng');
  });
});

// ---------------------------------------------------------------------------
// Sensitive field detection
// ---------------------------------------------------------------------------

describe('detectSensitiveType', () => {
  it('detects password by type', () => {
    const input = document.createElement('input');
    input.type = 'password';
    expect(detectSensitiveType(input)).toBe('password');
  });

  it('detects credit card by name attribute', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.name = 'credit-card-number';
    expect(detectSensitiveType(input)).toBe('credit-card');
  });

  it('detects SSN by id', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'ssn';
    expect(detectSensitiveType(input)).toBe('ssn');
  });

  it('detects CVV by placeholder', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'CVV';
    expect(detectSensitiveType(input)).toBe('cvv');
  });

  it('detects DOB by aria-label', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('aria-label', 'Date of birth');
    expect(detectSensitiveType(input)).toBe('dob');
  });

  it('returns null for non-sensitive fields', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.name = 'email';
    expect(detectSensitiveType(input)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sensitive fill confirmation
// ---------------------------------------------------------------------------

describe('sensitive fill confirmation', () => {
  it('password fill requires confirmation before filling', async () => {
    const input = document.createElement('input');
    input.type = 'password';
    const snap = makeSnapshot([input]);

    const result = await fillAction(
      [{ elementIndex: 1, value: 'my-secret-pwd' }],
      snap,
      'Filling password',
    );

    // Should NOT have filled the value
    expect(input.value).toBe('');
    expect(result).toContain('Filling your password');
    expect(result).toContain("Say 'confirm'");

    // Should have set a pending confirmation
    expect(hasPendingConfirm()).toBe(true);
  });

  it('credit card fill shows last 4 digits', async () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.name = 'cardnumber';
    const snap = makeSnapshot([input]);

    const result = await fillAction(
      [{ elementIndex: 1, value: '4111111111111234' }],
      snap,
      'Filling card',
    );

    expect(result).toContain('ending in 1234');
    expect(result).toContain("Say 'confirm'");
    expect(input.value).toBe(''); // Not filled yet
    expect(hasPendingConfirm()).toBe(true);
  });

  it('SSN fill shows last 4 digits', async () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'ssn';
    const snap = makeSnapshot([input]);

    const result = await fillAction(
      [{ elementIndex: 1, value: '123-45-6789' }],
      snap,
      '',
    );

    expect(result).toContain('ending in 6789');
    expect(result).toContain("Say 'confirm'");
    expect(hasPendingConfirm()).toBe(true);
  });

  it('clears pending confirm after checkConfirmation with confirmation', () => {
    // Set up a pending confirmation
    const input = document.createElement('input');
    input.type = 'password';
    const snap = makeSnapshot([input]);
    fillAction([{ elementIndex: 1, value: 'pwd' }], snap, '');
    expect(hasPendingConfirm()).toBe(true);

    // Confirm it
    const result = checkConfirmation('confirm');
    expect(result.isConfirm).toBe(true);
    expect(result.hadPending).toBe(true);
    expect(result.action).toBeDefined();
    expect(hasPendingConfirm()).toBe(false);
  });

  it('clears pending confirm on cancellation', () => {
    const input = document.createElement('input');
    input.type = 'password';
    const snap = makeSnapshot([input]);
    fillAction([{ elementIndex: 1, value: 'pwd' }], snap, '');
    expect(hasPendingConfirm()).toBe(true);

    const result = checkConfirmation('cancel');
    expect(result.isConfirm).toBe(false);
    expect(result.hadPending).toBe(true);
    expect(hasPendingConfirm()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// selectOption
// ---------------------------------------------------------------------------

describe('selectOption', () => {
  it('finds and selects option by text match', () => {
    const sel = document.createElement('select');
    sel.innerHTML = `
      <option value="us">United States</option>
      <option value="ng">Nigeria</option>
    `;

    const result = selectOption(sel, 'Nigeria');
    expect(result).toBe('');
    expect(sel.value).toBe('ng');
  });

  it('returns error when no matching option found', () => {
    const sel = document.createElement('select');
    sel.innerHTML = `
      <option value="us">United States</option>
      <option value="ng">Nigeria</option>
    `;

    const result = selectOption(sel, 'Canada');
    expect(result).toContain("couldn't find an option");
  });

  it('uses case-insensitive matching', () => {
    const sel = document.createElement('select');
    sel.innerHTML = `
      <option value="us">United States</option>
    `;

    selectOption(sel, 'united states');
    expect(sel.value).toBe('us');
  });

  it('dispatches change event after selection', () => {
    const sel = document.createElement('select');
    sel.innerHTML = `<option value="a">A</option><option value="b">B</option>`;
    const dispatchSpy = vi.spyOn(sel, 'dispatchEvent');

    selectOption(sel, 'B');

    const eventTypes = dispatchSpy.mock.calls.map(([e]) => (e as Event).type);
    expect(eventTypes).toContain('change');
  });
});

// ---------------------------------------------------------------------------
// confirmAction / checkConfirmation / hasPendingConfirm
// ---------------------------------------------------------------------------

describe('confirmation flow', () => {
  beforeEach(() => {
    // Clear any pending state by calling checkConfirmation with garbage
    // (hasPendingConfirm will be false, so it's a no-op, but if there's
    // state from previous tests, confirm+cancel will clear it)
    // Actually, modules keep state between tests — reset by calling
    // checkConfirmation with a dummy (no pending, so no-op)
    // We need a way to clear state
    checkConfirmation('dummy-clear'); // no-op when no pending
  });

  it('confirmAction stores pending action and returns speech', () => {
    const pending: DiamondAction = {
      action: 'click',
      elementIndex: 1,
      description: 'Submitting order',
    };

    const result = confirmAction(pending, 'This will submit your order. Say confirm.');

    expect(result).toBe('This will submit your order. Say confirm.');
    expect(hasPendingConfirm()).toBe(true);
  });

  it('checkConfirmation with "confirm" returns the stored action', () => {
    const pending: DiamondAction = {
      action: 'click',
      elementIndex: 1,
      description: 'Submitting',
    };
    confirmAction(pending, 'Confirm?');

    const result = checkConfirmation('confirm');

    expect(result.isConfirm).toBe(true);
    expect(result.hadPending).toBe(true);
    expect(result.action).toEqual(pending);
    expect(hasPendingConfirm()).toBe(false);
  });

  it('checkConfirmation with "cancel" clears pending and returns hadPending', () => {
    confirmAction(
      { action: 'click', elementIndex: 1, description: 'Test' },
      'Confirm?',
    );

    const result = checkConfirmation('no thanks');

    expect(result.isConfirm).toBe(false);
    expect(result.hadPending).toBe(true);
    expect(hasPendingConfirm()).toBe(false);
  });

  it('checkConfirmation with no pending returns isConfirm=false, hadPending=false', () => {
    const result = checkConfirmation('hello');

    expect(result.isConfirm).toBe(false);
    expect(result.hadPending).toBe(false);
  });

  it('hasPendingConfirm returns false initially', () => {
    expect(hasPendingConfirm()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// executeAction dispatcher
// ---------------------------------------------------------------------------

describe('executeAction dispatcher', () => {
  it('routes none actions to speech', async () => {
    const action: DiamondAction = { action: 'none', speech: 'Hello there' };
    const snap = makeSnapshot([]);
    const result = await executeAction(action, snap);
    expect(result).toBe('Hello there');
  });

  it('routes click actions to clickAction', async () => {
    const btn = document.createElement('button');
    btn.textContent = 'Go';
    // jsdom may not have scrollIntoView — stub it
    btn.scrollIntoView = (() => {}) as typeof btn.scrollIntoView;
    const snap = makeSnapshot([btn]);
    const clickSpy = vi.spyOn(btn, 'click');

    const action: DiamondAction = {
      action: 'click',
      elementIndex: 1,
      description: 'Clicking Go',
    };
    const result = await executeAction(action, snap);

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe('Clicking Go');
  });

  it('routes navigate actions to navigateAction', async () => {
    // Mock location for same-origin navigation test
    const mockHref = 'https://example.com/';
    const mockLocation = {
      origin: 'https://example.com',
      get href() { return mockHref; },
      set href(val: string) {
        // In tests, just store it — no actual navigation happens
        (mockLocation as Record<string, string>)._href = val;
      },
      _href: mockHref,
    };
    vi.stubGlobal('location', mockLocation);
    // Also ensure window.location is the same object
    Object.defineProperty(window, 'location', {
      value: mockLocation,
      writable: true,
      configurable: true,
    });
    vi.stubGlobal('window', { ...window, open: vi.fn() });

    const action: DiamondAction = {
      action: 'navigate',
      url: '/page',
      description: 'Going to page',
    };
    const snap = makeSnapshot([]);
    const result = await executeAction(action, snap);

    // Same-origin navigation returns empty string (navigation unloads page)
    expect(result).toBe('');
  });

  it('routes fill actions to fillAction', async () => {
    const input = document.createElement('input');
    input.type = 'text';
    const snap = makeSnapshot([input]);

    const action: DiamondAction = {
      action: 'fill',
      fields: [{ elementIndex: 1, value: 'test@test.com' }],
      description: 'Filling email',
    };
    const result = await executeAction(action, snap);

    expect(result).toBe('Filling email');
    expect(input.value).toBe('test@test.com');
  });

  it('routes confirm actions to confirmAction', async () => {
    const pending: DiamondAction = {
      action: 'click',
      elementIndex: 1,
      description: 'Delete item',
    };
    const action: DiamondAction = {
      action: 'confirm',
      speech: 'This will delete your item. Say confirm.',
      pendingAction: pending,
    };
    const snap = makeSnapshot([]);

    const result = await executeAction(action, snap);

    expect(result).toBe('This will delete your item. Say confirm.');
    expect(hasPendingConfirm()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error paths (DOC-CALL-STRATEGY §7)
// ---------------------------------------------------------------------------

describe('error paths', () => {
  it('clickAction with missing element returns specific error', () => {
    const snap = makeSnapshot([]);
    const result = clickAction(1, snap, 'Click');
    expect(result).toContain("couldn't find that element");
  });

  it('fillAction with missing element returns specific error', async () => {
    const snap = makeSnapshot([]);
    const result = await fillAction(
      [{ elementIndex: 1, value: 'test' }],
      snap,
      '',
    );
    expect(result).toContain("couldn't find");
  });

  it('fillAction with disabled field returns read-only error', async () => {
    const input = document.createElement('input');
    input.disabled = true;
    const snap = makeSnapshot([input]);

    const result = await fillAction(
      [{ elementIndex: 1, value: 'test' }],
      snap,
      '',
    );
    expect(result).toContain("couldn't fill");
  });

  it('navigateAction with javascript: URL returns security error', () => {
    const result = navigateAction('javascript:void(0)');
    expect(result).toContain("can't navigate to that type of URL");
  });

  it('selectOption without match returns specific error', () => {
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="a">A</option>';
    const result = selectOption(sel, 'Z');
    expect(result).toContain("couldn't find an option");
  });

  it('executeAction returns fallback for unknown action type', async () => {
    const snap = makeSnapshot([]);
    const badAction = { action: 'unknown' } as unknown as DiamondAction;
    const result = await executeAction(badAction, snap);
    expect(result).toContain('Something went wrong');
  });
});

// ---------------------------------------------------------------------------
// Confirmation phrasing matching
// ---------------------------------------------------------------------------

describe('confirmation phrasing', () => {
  it('accepts "yes" as confirmation', () => {
    confirmAction(
      { action: 'click', elementIndex: 1, description: 'Test' },
      'Confirm?',
    );
    const result = checkConfirmation('yes');
    expect(result.isConfirm).toBe(true);
  });

  it('accepts "go ahead" as confirmation', () => {
    confirmAction(
      { action: 'click', elementIndex: 1, description: 'Test' },
      'Confirm?',
    );
    const result = checkConfirmation('go ahead');
    expect(result.isConfirm).toBe(true);
  });

  it('accepts "proceed" as confirmation', () => {
    confirmAction(
      { action: 'click', elementIndex: 1, description: 'Test' },
      'Confirm?',
    );
    const result = checkConfirmation('proceed');
    expect(result.isConfirm).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listImagesAction — Image-describe feature (Phase J)
// ---------------------------------------------------------------------------

describe('listImagesAction', () => {
  function makeImg(label: string): HTMLElement {
    const img = document.createElement('img');
    img.alt = label;
    img.src = 'https://example.com/x.jpg';
    Object.defineProperty(img, 'getBoundingClientRect', {
      value: () => ({
        x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 100,
        width: 200, height: 100,
      }),
    });
    return img;
  }

  it('reports no images when none are present', async () => {
    const snap = makeSnapshot([]);
    const out = await executeAction(
      { action: 'list_images', description: '' },
      snap,
    );
    expect(typeof out).toBe('string');
    expect(out.toLowerCase()).toMatch(/no images/);
  });

  it('enumerates and indexes images in DOM order', async () => {
    document.body.appendChild(makeImg('Cover photo'));
    document.body.appendChild(makeImg('Hero illustration'));
    const snap = makeSnapshot([]);
    const out = await executeAction(
      { action: 'list_images', description: '' },
      snap,
    );
    expect(out).toMatch(/image 1.*Cover photo/i);
    expect(out).toMatch(/image 2.*Hero illustration/i);
  });
});

// ---------------------------------------------------------------------------
// listLinksAction — Link enumeration feature (mirror listImagesAction)
// ---------------------------------------------------------------------------

describe('listLinksAction', () => {
  function makeLink(text: string, href: string): HTMLAnchorElement {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = text;
    return a;
  }

  it('reports no links when none are present', async () => {
    const snap = makeSnapshot([]);
    const out = await executeAction(
      { action: 'list_links', description: '' },
      snap,
    );
    expect(typeof out).toBe('string');
    expect(out.toLowerCase()).toMatch(/no links/);
  });

  it('enumerates and indexes links in DOM order via snapshot', async () => {
    const link1 = makeLink('England vs DR Congo', '/news/england');
    const link2 = makeLink('Breaking News', '/news/breaking');
    const snap = makeSnapshot([link1, link2]);
    const out = await executeAction(
      { action: 'list_links', description: '' },
      snap,
    );
    expect(out).toMatch(/Number 1.*England/i);
    expect(out).toMatch(/Number 2.*Breaking/i);
  });

  it('skips javascript: and # URLs automatically', async () => {
    const valid = makeLink('Valid link', '/valid');
    const js = makeLink('JS link', 'javascript:void(0)');
    const frag = makeLink('Fragment', '#section');
    const snap = makeSnapshot([valid, js, frag]);
    const out = await executeAction(
      { action: 'list_links', description: '' },
      snap,
    );
    expect(out).toMatch(/Number 1.*Valid/i);
    expect(out).not.toMatch(/Number 2/);
    expect(out).not.toMatch(/Number 3/);
  });

  it('includes description prefix when provided', async () => {
    const link = makeLink('News Link', '/news');
    const snap = makeSnapshot([link]);
    const out = await executeAction(
      { action: 'list_links', description: 'Here are the stories' },
      snap,
    );
    expect(out).toMatch(/^Here are the stories/);
    expect(out).toMatch(/1 link/);
  });
});
