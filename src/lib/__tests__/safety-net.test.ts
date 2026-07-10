/**
 * Diamond Access AI — Safety Net Tests
 *
 * Phase H: Unit tests for wrapIrreversible keyword detection and
 * ERRORS constant completeness.
 */

import { describe, it, expect } from 'vitest';
import { wrapIrreversible } from '../safety-net';
import { ERRORS } from '../errors';
import type { DiamondAction } from '../actions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clickAction(
  elementText: string,
  description = 'click element',
): DiamondAction {
  return {
    action: 'click',
    elementIndex: 1,
    description,
  };
}

// ---------------------------------------------------------------------------
// wrapIrreversible — irreversible keyword matching
// ---------------------------------------------------------------------------

describe('wrapIrreversible keywords', () => {
  it('wraps click on "submit order" button in confirm', () => {
    const result = wrapIrreversible(
      clickAction('Submit Order', 'Submit Order'),
      'Submit Order',
    );
    expect(result.action).toBe('confirm');
    // Narrow type for speech/pendingAction access
    if (result.action !== 'confirm') return;
    expect(result.speech).toContain("Say 'confirm' to proceed");
    expect(result.pendingAction).toBeDefined();
    expect(result.pendingAction.action).toBe('click');
  });

  // Phase J (PC-QS-1) regression: harmless submit buttons must NOT be
  // wrapped in confirm. The universal `'submit'` keyword was removed
  // from safety-net to allow search/forms to submit without friction —
  // only destructive compounds like `submit order`, `submit application`,
  // `submit purchase` trigger confirm.
  it('passes through "Submit Search" unchanged', () => {
    const action = clickAction('Submit Search', 'Submit Search');
    const result = wrapIrreversible(action, 'Submit Search');
    expect(result.action).toBe('click');
  });

  it('passes through "Submit Comment" unchanged', () => {
    const action = clickAction('Submit Comment', 'Submit Comment');
    const result = wrapIrreversible(action, 'Submit Comment');
    expect(result.action).toBe('click');
  });

  it('passes through "Submit Post" unchanged', () => {
    const action = clickAction('Submit Post', 'Submit Post');
    const result = wrapIrreversible(action, 'Submit Post');
    expect(result.action).toBe('click');
  });

  it('wraps click on "delete account" in confirm', () => {
    const result = wrapIrreversible(
      clickAction('Delete Account permanently', 'Delete'),
      'Delete Account permanently',
    );
    expect(result.action).toBe('confirm');
  });

  it('wraps click on "purchase" in confirm', () => {
    const result = wrapIrreversible(
      clickAction('Complete Purchase', 'Purchase'),
      'Complete Purchase',
    );
    expect(result.action).toBe('confirm');
  });

  it('wraps click on "pay now" in confirm', () => {
    const result = wrapIrreversible(
      clickAction('Pay Now', 'Pay Now'),
      'Pay Now',
    );
    expect(result.action).toBe('confirm');
  });

  it('wraps click on "checkout" in confirm', () => {
    const result = wrapIrreversible(
      clickAction('Proceed to Checkout', 'Checkout'),
      'Proceed to Checkout',
    );
    expect(result.action).toBe('confirm');
  });

  it('wraps click on "place order" in confirm', () => {
    const result = wrapIrreversible(
      clickAction('Place order', 'Place Order'),
      'Place order',
    );
    expect(result.action).toBe('confirm');
  });

  it('passes through click on "Add to Cart" unchanged', () => {
    const action = clickAction('Add to Cart', 'Add to Cart');
    const result = wrapIrreversible(action, 'Add to Cart');
    // Add to Cart is NOT irreversible — it can be reversed
    expect(result.action).toBe('click');
  });

  it('passes through click on "read more" unchanged', () => {
    const action = clickAction('Read more about this', 'Read more');
    const result = wrapIrreversible(action, 'Read more about this');
    expect(result.action).toBe('click');
  });

  it('passes through click on shopping cart unchanged', () => {
    const action = clickAction('View Cart', 'View Cart');
    const result = wrapIrreversible(action, 'View Cart');
    expect(result.action).toBe('click');
  });
});

// ---------------------------------------------------------------------------
// wrapIrreversible — non-click actions never wrapped
// ---------------------------------------------------------------------------

describe('wrapIrreversible non-click actions', () => {
  it('returns navigate action unchanged', () => {
    const action: DiamondAction = {
      action: 'navigate',
      url: 'https://example.com',
      description: 'Go to example',
    };
    const result = wrapIrreversible(action, '');
    expect(result).toBe(action);
    expect(result.action).toBe('navigate');
  });

  it('returns fill action unchanged', () => {
    const action: DiamondAction = {
      action: 'fill',
      fields: [{ elementIndex: 1, value: 'test' }],
      description: 'Fill field',
    };
    const result = wrapIrreversible(action, '');
    expect(result).toBe(action);
    expect(result.action).toBe('fill');
  });

  it('returns none action unchanged', () => {
    const action: DiamondAction = {
      action: 'none',
      speech: 'Hello',
    };
    const result = wrapIrreversible(action, '');
    expect(result).toBe(action);
    expect(result.action).toBe('none');
  });

  it('returns confirm action unchanged', () => {
    const action: DiamondAction = {
      action: 'confirm',
      speech: 'Confirm?',
      pendingAction: { action: 'click', elementIndex: 1, description: 'test' },
    };
    const result = wrapIrreversible(action, '');
    expect(result).toBe(action);
    expect(result.action).toBe('confirm');
  });
});

// ---------------------------------------------------------------------------
// ERRORS constants completeness
// ---------------------------------------------------------------------------

describe('ERRORS constants', () => {
  it('all error constants are defined', () => {
    expect(ERRORS.MIC_BLOCKED).toBeTruthy();
    expect(ERRORS.STT_NETWORK).toBeTruthy();
    expect(ERRORS.AI_UNAVAILABLE).toBeTruthy();
    expect(ERRORS.SW_TERMINATED).toBeTruthy();
    expect(ERRORS.ELEMENT_NOT_FOUND).toBeTruthy();
    expect(ERRORS.FILL_FAILED).toBeTruthy();
    expect(ERRORS.NAV_FAILED).toBeTruthy();
    expect(ERRORS.SOMETHING_WRONG).toBeTruthy();
    expect(ERRORS.JS_REFUSED).toBeTruthy();
  });

  it('STT_NO_SPEECH is intentionally empty', () => {
    expect(ERRORS.STT_NO_SPEECH).toBe('');
  });

  it('function errors return correct format', () => {
    const confirm = ERRORS.SENSITIVE_CONFIRM('password');
    expect(confirm).toContain('password');
    expect(confirm).toContain("Say 'confirm'");

    const cc = ERRORS.SENSITIVE_CC_CONFIRM('1234');
    expect(cc).toContain('1234');
    expect(cc).toContain('card ending');

    const ssn = ERRORS.SENSITIVE_SSN_CONFIRM('6789');
    expect(ssn).toContain('6789');
    expect(ssn).toContain('SSN ending');

    const prompt = ERRORS.CONFIRM_PROMPT('submit your order');
    expect(prompt).toContain('submit your order');
    expect(prompt).toContain("Say 'confirm'");
  });

  it('CLEAR_CONTEXT returns expected string', () => {
    expect(ERRORS.CLEAR_CONTEXT).toBe('Context cleared.');
  });

  it('ACTION_CANCELLED returns expected string', () => {
    expect(ERRORS.ACTION_CANCELLED).toBe('Action cancelled.');
  });
});
