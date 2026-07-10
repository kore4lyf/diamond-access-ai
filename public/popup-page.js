// Diamond Access AI — Popup script (extension toolbar dropdown)
//
// Lives as an external script in public/ so Chrome MV3's strict CSP
// `script-src 'self'` doesn't block it. Inline <script> blocks would
// require `'unsafe-inline'` or a SHA256 pin.
//
// Loaded by src/entrypoints/popup.html.
// File path after WXT build: .output/chrome-mv3/popup-page.js
//
// Three responsibilities:
//   1. Show the current activation mode (GET_MODE → render).
//   2. Toggle the mode when the user clicks a row (SET_MODE → save + render).
//   3. Forward "Open Settings" to chrome.runtime.openOptionsPage().

(function init() {
  const modeRows = document.querySelectorAll('.mode-row');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const settingsLink = document.getElementById('settings-link');

  function setStatus(kind, text) {
    if (statusDot) statusDot.className = 'dot ' + kind;
    if (statusText) statusText.textContent = text;
  }

  function renderMode(mode) {
    modeRows.forEach(function (row) {
      const rowMode = row.getAttribute('data-mode');
      const input = row.querySelector('input[type="radio"]');
      const isSelected = rowMode === mode;
      if (input) input.checked = isSelected;
      row.classList.toggle('selected', isSelected);
    });
  }

  function wireModeClicks() {
    modeRows.forEach(function (row) {
      row.addEventListener('click', async function () {
        const mode = row.getAttribute('data-mode');
        // Defensive: only forward known modes.
        if (mode !== 'command' && mode !== 'hands_free') return;
        try {
          await chrome.runtime.sendMessage({
            type: 'SET_MODE',
            mode: mode,
          });
          renderMode(mode);
          setStatus(
            'idle',
            mode === 'hands_free'
              ? 'Hands-free mode.'
              : 'Command mode.',
          );
        } catch (err) {
          setStatus(
            'err',
            'Could not save mode: ' +
              (err && err.message ? err.message : String(err)),
          );
        }
      });
    });
  }

  function wireSettingsLink() {
    if (!settingsLink) return;
    settingsLink.addEventListener('click', function (e) {
      e.preventDefault();
      try {
        // Tell the SW to broadcast that we're opening Options, then open it.
        chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS_CLICKED' }).catch(function () {});
        chrome.runtime.openOptionsPage();
        window.close();
      } catch {
        // Fallback: explicitly open options.html in a new tab.
        chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
        window.close();
      }
    });
  }

  function loadInitialMode() {
    if (!chrome.runtime || !chrome.runtime.sendMessage) {
      setStatus('err', 'Extension messaging unavailable.');
      return;
    }
    chrome.runtime
      .sendMessage({ type: 'GET_MODE' })
      .then(function (response) {
        const mode =
          response && (response.mode === 'hands_free' ? 'hands_free' : 'command');
        renderMode(mode);
        setStatus(
          'idle',
          mode === 'hands_free'
            ? 'Hands-free mode.'
            : 'Command mode.',
        );
      })
      .catch(function () {
        // SW not ready (rare on first popup open) — fall back to default.
        renderMode('command');
        setStatus('idle', 'Command mode.');
      });
  }

  // Live update if the user (or another helper) changes mode in another
  // popup window. chrome.storage.onChanged is silent — only fires when
  // a key we filter actually changes.
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (changes && changes.diamond_mode) {
        const next =
          changes.diamond_mode.newValue === 'hands_free' ? 'hands_free' : 'command';
        renderMode(next);
      }
    });
  }

  wireModeClicks();
  wireSettingsLink();
  loadInitialMode();
})();
