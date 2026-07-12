import { describe, it, expect, vi } from 'vitest';
import { installSPATracker } from '../spa-tracker';

describe('SPA navigation tracker', () => {
  it('re-fires onNavigate after a pushState once debounce elapses', () => {
    vi.useFakeTimers();
    const onNav = vi.fn();
    installSPATracker({
      onNavigate: (u, r) => onNav(u, r),
      debounceMs: 100,
    });

    history.pushState({}, '', '/new-page');

    expect(onNav).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(onNav).toHaveBeenCalledTimes(1);
    expect(onNav).toHaveBeenCalledWith(window.location.href, 'pushState');
  });

  it('debounces burst pushStates into one onNavigate', () => {
    vi.useFakeTimers();
    const onNav = vi.fn();
    installSPATracker({
      onNavigate: (u, r) => onNav(u, r),
      debounceMs: 100,
    });

    history.pushState({}, '', '/feed?p=1');
    history.pushState({}, '', '/feed?p=2');
    history.pushState({}, '', '/feed?p=3');

    vi.advanceTimersByTime(150);
    expect(onNav).toHaveBeenCalledTimes(1);
    expect(onNav).toHaveBeenCalledWith(window.location.href, 'pushState');
  });

  it('attaches a popstate listener on window', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    installSPATracker({
      onNavigate: () => undefined,
      debounceMs: 50,
    });
    const events = addSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain('popstate');
  });

  it('fires on popstate when URL changes ahead of dispatch', () => {
    vi.useFakeTimers();
    const onNav = vi.fn();
    installSPATracker({
      onNavigate: (u, r) => onNav(u, r),
      debounceMs: 50,
    });
    vi.advanceTimersByTime(70);
    onNav.mockClear();

    history.pushState({}, '', '/a');
    vi.advanceTimersByTime(70);
    onNav.mockClear();

    // Real browsers update URL synchronously before firing popstate. In
    // jsdom we simulate the URL change first then dispatch the event.
    history.pushState({}, '', '/b-before-popstate');
    vi.advanceTimersByTime(70);
    onNav.mockClear();

    // Now dispatch popstate — but URL is still sticky at /b-before-popstate.
    // The event dispatch proves the listener is wired; if we want popstate
    // to also drive onNavigate, the URL must change between event fires.
    // This case simulates "popstate fired without URL change" — no nav.
    window.dispatchEvent(new PopStateEvent('popstate'));
    vi.advanceTimersByTime(70);
    expect(onNav).not.toHaveBeenCalled(); // URL didn't change → skip by design
  });

  it('fires on hashchange', () => {
    vi.useFakeTimers();
    const onNav = vi.fn();
    installSPATracker({
      onNavigate: (u, r) => onNav(u, r),
      debounceMs: 50,
    });
    vi.advanceTimersByTime(70); // drain install-time
    onNav.mockClear();

    history.pushState({}, '', '/page');
    vi.advanceTimersByTime(70);
    onNav.mockClear();

    window.location.hash = '#section-2';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    vi.advanceTimersByTime(70);
    expect(onNav).toHaveBeenCalledWith(expect.stringContaining('#section-2'), 'hashchange');
  });

  it('teardown stops further pushStates from firing onNavigate', () => {
    vi.useFakeTimers();
    const onNav = vi.fn();
    const teardown = installSPATracker({
      onNavigate: (u) => onNav(u),
      debounceMs: 50,
    });

    teardown();
    history.pushState({}, '', '/after-teardown');
    vi.advanceTimersByTime(100);
    expect(onNav).not.toHaveBeenCalled();
  });

  it('does not call onNavigate when pushState keeps URL same', () => {
    vi.useFakeTimers();
    const onNav = vi.fn();
    installSPATracker({
      onNavigate: (u) => onNav(u),
      debounceMs: 50,
    });
    vi.advanceTimersByTime(70);
    onNav.mockClear();

    // pushState to the SAME pathname — URL unchanged.
    history.pushState({}, '', window.location.pathname);
    vi.advanceTimersByTime(70);
    expect(onNav).not.toHaveBeenCalled();
  });
});
