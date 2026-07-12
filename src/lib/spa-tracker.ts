// SPA navigation tracker.
//
// Most modern websites are SPAs — Twitter, Gmail, Instagram, GitHub,
// Reddit, news outlets, etc. They update the URL via history.pushState,
// history.replaceState, popstate, or hashchange WITHOUT a real page
// reload. Diamond's PAGE_LOAD summary only fires once on document_idle,
// so after one in-app click the user is on a "new" page but Diamond
// still thinks they're on the first one — stale summary, stale element
// list, wrong element indices.
//
// This module wires three hooks:
//   1. Monkey-patches history.pushState / replaceState
//   2. Listens to popstate (browser back/forward)
//   3. Listens to hashchange
// Each URL change is debounced (800ms) and triggers a callback that
// receives the new URL. Sites like Twitter pushState in tight loops
// during infinite scroll — without debouncing we'd fire a new
// PAGE_LOAD on every URL update.

export interface SPATrackerOptions {
  /**
   * Called when a fresh URL is detected. Receives the new URL and the
   * signal that triggered the change ('pushState' | 'replaceState' |
   * 'popstate' | 'hashchange').
   *
   * The debounce timer is reset on every change so a tight burst of
   * pushStates collapses into one callback (e.g., scroll trigger).
   */
  onNavigate: (url: string, reason: string) => void;
  /** Debounce milliseconds. Default 800ms. */
  debounceMs?: number;
  /** Optional getter for the "current" URL — defaults to window.location.href. */
  getCurrentUrl?: () => string;
  /** History impl — defaults to window.history. Override in tests. */
  history?: History;
  /** Window impl — defaults to window. Override in tests. */
  window?: Window;
}

/**
 * Install SPA navigation tracking. Returns a teardown function that
 * restores the original history methods and removes event listeners.
 */
export function installSPATracker(options: SPATrackerOptions): () => void {
  const fallbackWindow = typeof window !== 'undefined' ? window : undefined;
  const opts = {
    debounceMs: options.debounceMs ?? 800,
    getCurrentUrl: options.getCurrentUrl ?? (() => fallbackWindow?.location.href ?? ''),
    history: options.history ?? fallbackWindow?.history,
    window: options.window ?? fallbackWindow,
    onNavigate: options.onNavigate,
  } as Required<SPATrackerOptions>;

  if (!opts.history || !opts.window) {
    return () => undefined;
  }

  let lastReportedUrl = opts.getCurrentUrl();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (reason: string) => {
    const currentUrl = opts.getCurrentUrl();
    if (currentUrl === lastReportedUrl) return;
    lastReportedUrl = currentUrl;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      opts.onNavigate(currentUrl, reason);
    }, opts.debounceMs);
  };

  const originalPushState = opts.history.pushState.bind(opts.history);
  const originalReplaceState = opts.history.replaceState.bind(opts.history);

  opts.history.pushState = function (
    ...args: Parameters<typeof history.pushState>
  ): void {
    const r = originalPushState(...args);
    schedule('pushState');
    return r as unknown as void;
  };
  opts.history.replaceState = function (
    ...args: Parameters<typeof history.replaceState>
  ): void {
    const r = originalReplaceState(...args);
    schedule('replaceState');
    return r as unknown as void;
  };

  const onPopState = () => schedule('popstate');
  const onHashChange = () => schedule('hashchange');
  opts.window.addEventListener('popstate', onPopState);
  opts.window.addEventListener('hashchange', onHashChange);

  return function teardown() {
    if (timer) clearTimeout(timer);
    opts.history!.pushState = originalPushState;
    opts.history!.replaceState = originalReplaceState;
    opts.window!.removeEventListener('popstate', onPopState);
    opts.window!.removeEventListener('hashchange', onHashChange);
  };
}
