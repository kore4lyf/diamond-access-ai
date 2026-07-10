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

  // ─────────────────────────────────────────────────────────────────────
  // Diagnostics panel — pull the service-worker log buffer via
  // chrome.runtime.sendMessage and render it for inspection.
  // The buffer is per-script-instance; this only shows the SW buffer
  // (the most operational one). Content-script logs are viewable in
  // DevTools on the page itself.
  // ─────────────────────────────────────────────────────────────────────
  const refreshLogsBtn = document.getElementById('refresh-logs-btn');
  const clearLogsBtn = document.getElementById('clear-logs-btn');
  const logsPre = document.getElementById('logs-pre');

  function formatEntry(e) {
    const ts = new Date(e.ts || Date.now()).toISOString().slice(11, 23);
    const lvl = String(e.level || 'INFO').toUpperCase().padEnd(5);
    const cat = String(e.cat || 'unknown').padEnd(15);
    const msg = String(e.msg || '');
    const data =
      e.data && typeof e.data === 'object' && Object.keys(e.data).length > 0
        ? ' ' + JSON.stringify(e.data)
        : '';
    return ts + ' ' + lvl + ' ' + cat + ' ' + msg + data;
  }

  if (refreshLogsBtn && logsPre) {
    refreshLogsBtn.addEventListener('click', async function () {
      try {
        const response = await chrome.runtime.sendMessage({ type: 'GET_LOGS' });
        const entries = (response && response.logs) || [];
        if (entries.length === 0) {
          logsPre.textContent = '(no log entries yet — use Diamond first)';
          return;
        }
        const lines = entries.map(formatEntry);
        logsPre.textContent = lines.join('\n');
      } catch (err) {
        logsPre.textContent =
          'Could not fetch logs: ' +
          (err && err.message ? err.message : String(err));
      }
    });
  }

  if (clearLogsBtn) {
    clearLogsBtn.addEventListener('click', async function () {
      try {
        await chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' });
        if (logsPre) logsPre.textContent = '(cleared)';
        setStatus('Log buffer cleared.', 'ok');
      } catch (err) {
        setStatus(
          'Could not clear logs: ' +
            (err && err.message ? err.message : String(err)),
          'err',
        );
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Verbose LLM response log — read from chrome.storage.local
  // (sink: src/lib/fireworks.ts captureVerboseLLMBody). The diamond_verbose_llm
  // opt-in flag enables this sink; production CRX without that flag never
  // writes anything here. Refreshing / copying / downloading all read the
  // same key the SW writes.
  // ─────────────────────────────────────────────────────────────────────
  var refreshVerboseBtn  = document.getElementById('refresh-verbose-btn');
  var copyVerboseBtn     = document.getElementById('copy-verbose-btn');
  var downloadVerboseBtn = document.getElementById('download-verbose-btn');
  var clearVerboseBtn    = document.getElementById('clear-verbose-btn');
  var verbosePre         = document.getElementById('verbose-pre');

  async function fetchVerboseBuffer() {
    if (!verbosePre) return [];
    try {
      var stored = await chrome.storage.local.get('diamond_verbose_log_buffer');
      var buf = Array.isArray(stored.diamond_verbose_log_buffer)
        ? stored.diamond_verbose_log_buffer
        : [];
      if (buf.length === 0) {
        verbosePre.textContent =
          '(no verbose entries — set diamond_verbose_llm=true and use Diamond)';
        return [];
      }
      var lines = buf.map(function (e) {
        var when = new Date(e.ts || Date.now())
          .toISOString()
          .replace('T', ' ')
          .slice(0, 19);
        // User speech entries (kind:'user_speech') take a different
        // shape — single transcript line, no attempt/system/raw. Older
        // LLM-only entries (no `kind` field) read back as llm here.
        if (e.kind === 'user_speech') {
          return (
            '\u2500\u2500 ' + when + ' \u25b6 USER SAID \u2500\u2500\n' +
            String(e.transcript || '')
          );
        }
        return (
          '\u2500\u2500 ' + when + ' attempt=' + (e.attempt == null ? '?' : e.attempt) + ' \u2500\u2500\n' +
          'system: ' + String(e.systemPrompt || '').slice(0, 240) + '\n' +
          'user: '   + String(e.userMessage  || '').slice(0, 240) + '\n' +
          'raw:\n'   + String(e.raw         || '')
        );
      });
      verbosePre.textContent = lines.join('\n\n');
      return buf;
    } catch (err) {
      verbosePre.textContent =
        'Could not read verbose log: ' +
        (err && err.message ? err.message : String(err));
      return [];
    }
  }

  if (refreshVerboseBtn) {
    refreshVerboseBtn.addEventListener('click', function () {
      fetchVerboseBuffer();
    });
  }
  if (copyVerboseBtn) {
    copyVerboseBtn.addEventListener('click', async function () {
      var buf = await fetchVerboseBuffer();
      try {
        await navigator.clipboard.writeText(JSON.stringify(buf, null, 2));
        setStatus('Verbose log copied (JSON).', 'ok');
      } catch (err) {
        setStatus(
          'Copy failed: ' + (err && err.message ? err.message : String(err)),
          'err',
        );
      }
    });
  }
  if (downloadVerboseBtn) {
    downloadVerboseBtn.addEventListener('click', async function () {
      var buf = await fetchVerboseBuffer();
      var blob = new Blob([JSON.stringify(buf, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download =
        'diamond-verbose-log-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(url);
    });
  }
  if (clearVerboseBtn) {
    clearVerboseBtn.addEventListener('click', async function () {
      try {
        await chrome.storage.local.remove('diamond_verbose_log_buffer');
        if (verbosePre) verbosePre.textContent = '(cleared)';
        setStatus('Verbose log buffer cleared.', 'ok');
      } catch (err) {
        setStatus(
          'Could not clear verbose log: ' +
            (err && err.message ? err.message : String(err)),
          'err',
        );
      }
    });
  }
})();
