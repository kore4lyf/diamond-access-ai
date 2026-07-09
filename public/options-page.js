// Diamond Access AI — Options Page script (Phase A + Phase I gap-fix)
//
// Lives as an external script (in public/) so Chrome MV3's strict CSP
// `script-src 'self'` doesn't block it. Inline <script> blocks would
// require the manifest to enable 'unsafe-inline' or pin a specific
// sha256 hash — both fragile across edits.
//
// Loaded by src/entrypoints/options.html.
// File path after WXT build: .output/chrome-mv3/options-page.js

(function init() {
  const input = document.getElementById('api-key-input');
  const saveBtn = document.getElementById('save-btn');
  const status = document.getElementById('status');
  const showKeyCheckbox = document.getElementById('show-key-checkbox');

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = 'status' + (kind ? ' ' + kind : '');
  }

  // Toggle input masking. The typed value is preserved across toggles —
  // only the input.type changes; the value stays.
  showKeyCheckbox.addEventListener('change', function () {
    input.type = showKeyCheckbox.checked ? 'text' : 'password';
  });

  // Load existing key on mount.
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get('diamond_api_key').then(function (result) {
      const savedKey = result && result.diamond_api_key;
      if (typeof savedKey === 'string' && savedKey.length > 0) {
        input.value = savedKey;
        setStatus('API key loaded from local storage.', '');
      }
    }).catch(function () {
      // Storage not available yet — fine, just don't pre-fill.
    });
  }

  // Save on button click.
  //
  // Empty input acts as "clear" — removes the stored key. This matches
  // the user's intent: no dedicated Clear button, but explicit emptiness
  // is treated as a removal so users can wipe without saving a dummy.
  saveBtn.addEventListener('click', async function () {
    const key = (input.value || '').trim();
    if (!key) {
      try {
        await chrome.storage.local.remove('diamond_api_key');
        setStatus('API key cleared.', '');
      } catch (e) {
        setStatus('Could not clear (storage unavailable): ' + e.message, 'err');
      }
      return;
    }
    try {
      await chrome.storage.local.set({ diamond_api_key: key });
      setStatus('API key saved!', 'ok');
    } catch (e) {
      setStatus('Could not save (storage unavailable): ' + e.message, 'err');
    }
  });

  // Save on Enter inside the input.
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveBtn.click();
    }
  });
})();
