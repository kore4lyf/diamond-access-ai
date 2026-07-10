# Diamond Access AI — PC QA Tests (deferred from Termux)

> **Status:** Living doc — items here CANNOT run on Termux/Android. They require a real PC with Chrome/Chromium that can load an unpacked extension.
> **Audience:** QA (when the repo is moved to PC).
> **Convention:** One block per deliverable, newest at the top.
> **Rule:** These checks are tracked separately from `doc/TO-QA.md`. They do **not** block merge on Termux. They MUST pass before the phase is marked fully complete and before the hackathon demo.

---

## Platform assumptions

- OS: PC (Linux/macOS/Windows) with Desktop Chrome or Chromium.
- Repo cloned fresh, `pnpm install` run once on PC.
- Developer mode enabled in `chrome://extensions`.
- Load `.output/...` (WXT build output) as an unpacked extension.
- A **dummy** Fireworks API key is acceptable for scaffold checks — do not burn real credits. If a real key is used, purge local storage after testing.

---

## Phase A — Project Scaffold (PC checks)

These cover the "load in Chrome" half of Phase A that Termux cannot do.

| # | Test | Steps | Expected |
|---|------|-------|----------|
| PC-A-1 | Extension loads without errors | `pnpm build`; load `.output/...` unpacked in Chrome; open `chrome://extensions` | Diamond extension card visible, status "Enabled", **no "Errors" button** on the card. |
| PC-A-2 | Build artifacts correct | Inspect `.output/...` | `manifest.json`, `background.js` (or service worker bundle), `content.js`, `options.html`, `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png` all present. |
| PC-A-3 | Service worker logs cleanly | Click extension card → "Service worker" (or Inspect views: service worker) | Console shows the background load log; **no red errors**; **no uncaught promise rejections**. |
| PC-A-4 | Content script loads on every page | Navigate to `https://example.com`; DevTools → Console | Sees: `Diamond Access AI content script loaded`. |
| PC-A-5 | Background receives PAGE_LOAD | With example.com open, inspect the service worker console | Sees a log line with `{ type: 'PAGE_LOAD', url: 'https://example.com/' }`. (Confirms message passing onMessage → listener returns true chains correctly.) |
| PC-A-6 | Options page round-trips key | Right-click extension icon → Options; type `fw_test_dummy_key_not_real`; Save; close & reopen Options | Input is pre-filled with the saved value. |
| PC-A-7 | Key persists in storage | While options open, DevTools → Application → Local Storage → extension origin | Key `diamond_api_key` equals the saved value. |
| PC-A-8 | Keyboard shortcut registered | Open `chrome://extensions/shortcuts` (or Chrome Settings → Extensions → Keyboard shortcuts) | `Alt+D` bound to "Activate Diamond listening"; `Alt+Shift+D` is the fallback. |
| PC-A-9 | Icon click won't throw | Click the Diamond toolbar icon | Service worker console logs the `action.onClicked` line; no error. (Pressing Alt+D here may log nothing yet — full keybinding handling arrives in Phase D.) |
| PC-A-10 | Strict CSP / no inline handlers | Inspect `options.html` source | No inline `<script>` or `onclick=` handlers (MV3 CSP forbids them). Script is an external file. |
| PC-A-11 | Reload survives update | Edit `content.ts` log message; `pnpm build`; click extension card → Reload | New log message appears on next page load; no orphaned context. |
| PC-A-12 | No cross-tab access | Open a second tab to any site; check that content script logs in BOTH but the service worker has no `tabs`-enumeration logs | Confirms no `tabs` permission was added; each tab is independent. |
| PC-A-13 | Cleanup | After testing, remove the dummy key from local storage (DevTools → Application → Local Storage → clear) | No test key lingering for the next session. |

**Pass criteria for Phase A (full):** all `doc/TO-QA.md` §Deliverable #1 CR/QA items pass **and** PC-A-1 … PC-A-13 pass.

---

## Phase B — DOM Walk Engine (PC checks)

These cover "run the walker against a real Chrome DOM" — deferring shadow DOM / iframe / live-page behavior that jsdom can't model.

| # | Test | Steps | Expected |
|---|------|-------|----------|
| PC-B-1 | Walker produces a tree on a real article page | Load extension in Chrome; navigate to `https://example.com`; DevTools → Service worker console. Run (via a temporary debug hook or a `window.__diamondExtract()` test hook the engineer adds behind a `process.env.NODE_ENV !== 'production'` gate): `extractPageStructure()`. *(If the engineer didn't add a hook, run `pnpm dev` and use the content-script console instead: it has access to the page DOM.)* | Returns a non-empty string; contains at least one `heading`/`link`/`main`/`paragraph` line; indentation reflects nesting. |
| PC-B-2 | E-commerce product page produces rich tree | Navigate to a product page on Amazon or similar; trigger extraction. | Tree contains `button "Add to Cart"` or equivalent, `link` lines for nav, `img "<product>"` lines for product thumbnails. Top-3 levels not truncated. |
| PC-B-3 | Noise actually skipped on a real page | Same product page. | Tree contains NO lines for inline `<svg>` icons, `<script>`, `<style>`, or `[aria-hidden="true"]` chrome (modals/dropdowns). Confirm by spot-check: count of `svg` lines in output === 0. |
| PC-B-4 | Token budget respected on heavy SPA | Navigate to a complex dashboard (e.g., a GitHub repo board or equivalent SPA with 200+ nodes); trigger extraction. | Output ≤ 1500 chars (configured max) OR contains the `… N more children` summary line; top-3-level interactive elements still present. |
| PC-B-5 | Determinism across reload | Reload the page; trigger extraction twice. | Both output strings are byte-identical (compare lengths and first/last 200 chars if full diff is hard). |
| PC-B-6 | Perf on real DOM | Time `extractPageStructure()` via `console.time`/`console.timeEnd` on the heavy SPA. | < 200ms. Flag to PM if > 500ms — adding a perf budget regression test on PC. |
| PC-B-7 | Shadow DOM spot-check | Visit a page with a known shadow-root component (e.g., a Twitter/X post or a page using a web component). | Shadow-root content is NOT in the tree (expected for MVP — light DOM only). Document as a known limitation; route to `DOC-FUTURE-UPDATES.md`. Do NOT file as a Phase B bug. |
| PC-B-8 | Iframes spot-check | Visit a page with an embedded `<iframe>` (e.g., a YouTube embed on a third-party page). | Iframe content is NOT in the tree (`IFRAME` is in the skip set). Confirm no iframe content leaks in. |
| PC-B-9 | No DOM mutation observed | Before extraction, snapshot `document.body.outerHTML` length; trigger extraction; snapshot again. | Lengths equal — walker did not mutate the DOM. |
| PC-B-10 | Cleanup | Remove any debug hook / `__diamondExtract` window global used for testing before final Phase B merge. | No test hooks shipped to production. |

---

## How to record results when on PC

For each row, log:
- ✅ Pass / ❌ Fail
- Terminal/command output if Fail
- Chrome version + OS

Append results to the bottom of the corresponding Phase section, or to a sibling `PC-QA-RESULTS.md` if we want to keep this file clean. (PM will decide format when we reach PC.)

---

## Phase C — Fireworks API Client (PC checks)

These cover "live Fireworks call from a real Chrome service worker" — the one sanctioned touch of real credits during development. All others mock `fetch`.

> **Credit discipline:** Phase C uses **MiniMax M3 only** (`accounts/fireworks/models/minimax-m3`). Do NOT run any check against the production Gemma deployment. Each live call costs real money against the $50 credit. Run PC-C-1 **once** to confirm the wiring, then stop. Do not loop it.

| # | Test | Steps | Expected |
|---|------|-------|----------|
| PC-C-1 | Live Fireworks round-trip via SW console | Load unpacked extension in Chrome. Open `chrome://extensions` → Diamond Access AI → "Service worker" (inspect). In the SW console, run: `chrome.runtime.sendMessage({type:'FIREWORKS_TEST'}, (r) => console.log('FIREWORKS_TEST result:', r))`. (Ensure an API key is set in the extension options first.) | Console logs `{ ok: true, reply: 'OK' }` (or a short string containing "OK"). Latency < 3s. If `ok:false`: read `error` — if it's a 401/403, the key is wrong; if it's a network error, check connectivity; do NOT swap models. |
| PC-C-2 | Missing-key path on real Chrome | Delete the API key in extension options (clear the field, save). Reload SW. Re-run the `FIREWORKS_TEST` message. | `{ ok: false, error: 'API key not configured. Open extension settings.' }`. Diamond does NOT crash; no uncaught error in the SW console beyond the handled throw. |
| PC-C-3 | Network failure path | Disconnect network (or block `api.fireworks.ai` via DevTools Network tab → Block request URL). Run `FIREWORKS_TEST`. | After ~1s (retry), `{ ok: false, error: 'Fireworks API call failed' }`. Reviewer confirms retry waited ~1s, not instant. |
| PC-C-4 | Content script still does NOT call Fireworks | On any page where the content script is injected, open the page's DevTools console and check the Network tab. Reload. | The content-script frame makes ZERO requests to `api.fireworks.ai`. All Fireworks traffic originates from the service worker (seen in `chrome://extensions` SW DevTools, not page DevTools). |
| PC-C-5 | Permissions unchanged in loaded extension | In `chrome://extensions` → Diamond Access AI, read the listed permissions. | Only `activeTab` and `storage` requested. No `host_permissions`, no `tabs`, no `scripting`. |
| PC-C-6 | Cleanup | After PC-C-1 passes once, do NOT keep calling it. Leave the wiring in place (it's the diagnostics path); just don't burn more credits. | - |

**Pass criteria for Phase C (full):** all `doc/TO-QA.md` §Deliverable #3 CR/QA items pass on Termux **and** PC-C-1 + PC-C-4 + PC-C-5 pass on PC (PC-C-2/PC-C-3 recommended but optional before Phase E).

---

## Phase D — Voice Pipeline (PC checks)

Real mic, real `SpeechRecognition`, real `speechSynthesis`, real `AudioContext`, real Alt+D. None of these exist in jsdom. **These are the gates that prove Diamond is actually usable by a blind person.**

> **Screen-reader coexistence:** If NVDA/JAWS/VoiceOver is running during any PC-D test, Diamond's `speak()` must NOT call `speechSynthesis.cancel()` (Phase D doesn't, by design). Verify the SR's current utterance is not killed when Diamond speaks. (CR-D6 enforced this in code; PC-D-7 verifies it at runtime.)

| # | Test | Steps | Expected |
|---|------|-------|----------|
| PC-D-1 | Alt+D activates listening | Load extension in Chrome. Navigate to any page. Press **Alt+D**. | Console logs `[Diamond] transcript:` after speech. An awake beep (880Hz) plays on activation. If Alt+D is hijacked by Chrome's omnibox, try **Alt+Shift+D** (fallback command) — at least one works. |
| PC-D-2 | STT round-trips a real phrase | Press Alt+D, say clearly: "summarize this page". | Console logs `[Diamond] transcript: summarize this page` (or close). Latency < 3s for cloud STT; < 1s if on-device available. |
| PC-D-3 | TTS speaks back | (Phase D smoke path) After transcript, `speak('You said: ' + transcript)` fires. | Browser speaks the phrase via OS TTS. Voice is `localService` en-US if available. |
| PC-D-4 | Beep cues audible | Press Alt+D (awake beep). Wait 60s with no speech (sleep beep). | Awake = 880Hz blip on activation. Sleep = 440Hz blip after 60s idle. Both audible. |
| PC-D-5 | Double Alt+D no-op | Press Alt+D twice in rapid succession (< 200ms). | Only ONE listening session starts (`isListening` guard). One beep, one `transcript` log, not two. |
| PC-D-6 | Mic-blocked error path | In `chrome://settings/content/microphone`, block the site. Reload page. Press Alt+D. | Diamond speaks (or logs) "Microphone access is blocked. Please allow mic permissions." No uncaught exception in content-script console. |
| PC-D-7 | Screen-reader coexistence | Launch NVDA (or VoiceOver/JAWS). Navigate to a page. While SR is mid-utterance, press Alt+D and let Diamond respond. | Diamond's `speak()` does NOT kill the SR's current utterance (no `speechSynthesis.cancel()`). SR resumes/completes; Diamond's speech is additive. |
| PC-D-8 | No network from content | During a full Alt+D listen+speak cycle, open page DevTools → Network tab. | The content-script frame makes ZERO requests to `api.fireworks.ai` or anywhere. (Phase D has no LLM call; Phase E will route that via the SW.) |
| PC-D-9 | Permissions unchanged | `chrome://extensions` → Diamond Access AI → permissions. | Only `activeTab`, `storage`. No `tabs`, `scripting`, or mic permission requested (Chrome handles mic via the Web Speech API prompt, not a manifest permission). |
| PC-D-10 | On-device STT (best-effort) | If Chrome 139+ and `SpeechRecognition.available({langs:['en-US'], processLocally:true})` returns `'available'`: toggle the feature path. Press Alt+D, disconnect network, speak. | On-device mode recognizes speech with NO network (confirm Network tab is empty during recognition). If unavailable, cloud mode is fine — not a blocker. |

**Pass criteria for Phase D (full):** all `doc/TO-QA.md` §Deliverable #4 CR/QA items pass on Termux **and** PC-D-1, PC-D-2, PC-D-3, PC-D-5, PC-D-7 pass on PC (PC-D-4/PC-D-6/PC-D-8/PC-D-9/PC-D-10 recommended). PC-D-7 (SR coexistence) is non-negotiable for the accessibility mission — if Diamond kills an SR utterance, that's a Phase D blocker.

---

## Phase E — Command Integration (PC checks)

Full round-trip: Alt+D → listen → page snapshot (structure + elementIndex map) → COMMAND message to SW → `callLLMWithRetry` (MiniMax M3) → action JSON or speech → content script executes or speaks. VLM fallback on sparse DOM via `captureVisibleTab`. **This is the hackathon demo heart — everything must work end-to-end.**

| # | Test | Steps | Expected |
|---|------|-------|----------|
| PC-E-1 | Alt+D full round-trip (shopping) | Load extension. Navigate to a demo shopping page (e.g., a product grid). Press Alt+D, say "list the products on this page". | Diamond extracts page structure, sends to SW, LLM returns JSON `{"action":"none","speech":"There are 4 products..."}`, content script speaks the summary. No console errors. |
| PC-E-2 | elementIndex click works | On a page with numbered interactive elements, press Alt+D, say "click the add to cart button". | LLM returns `{"action":"click","elementIndex":N,"description":"..."}`. Content script resolves `elements[N-1].click()`. The button visually activates (or console logs the click). |
| PC-E-3 | fill form works | On a login/register form, press Alt+D, say "fill the email field with test@example.com". | LLM returns `{"action":"fill","fields":[{"elementIndex":M,"value":"test@example.com"}],...}`. Content script sets the field value and dispatches `input`/`change`. Field visibly updates. |
| PC-E-4 | VLM fallback triggers on sparse DOM | Navigate to a canvas-heavy or image-only demo page (or a page with `< 3` interactive elements). Press Alt+D, say "describe this page". | Content detects sparse DOM → sends `VLM_REQUEST` → SW calls `captureVisibleTab` → MiniMax M3 multimodal call → description returned → spoken. Network tab shows one request to `api.fireworks.ai` with `image_url`. |
| PC-E-5 | captureVisibleTab under activeTab only | Verify `chrome.tabs.captureVisibleTab` works without `tabs` or `<all_urls>` permission. | Screenshot captured successfully. If it fails, the fallback text prompt is used and a warning is logged — not a crash. |
| PC-E-6 | PAGE_LOAD auto-summary | Open a new tab to any page. | Background receives `PAGE_LOAD`, calls LLM with "You are on <url>..." prompt, returns summary, content script speaks it. User hears a one-sentence page description on load. |
| PC-E-7 | SW termination resilience | (Simulate) Kill the service worker mid-round-trip (DevTools → Application → Service Workers → Unregister). Press Alt+D and issue a command. | Content script catches "message channel closed" / "receiving end does not exist", speaks "The AI service is temporarily unavailable." No uncaught exception, voice loop remains functional. |
| PC-E-8 | confirm action flow | On a checkout page, press Alt+D, say "submit this order". | LLM returns `confirm` schema with `pendingAction`. Diamond speaks the confirmation prompt. User says "confirm". Next COMMAND detects the keyword, executes the pending action. |
| PC-E-9 | MiniMax M3 only (no Gemma) | Grep the built `background.js` and `content.js` for model IDs. | Only `minimax-m3` appears. No `akfaleye`/`t5rv9ps1`/`gemma`. |
| PC-E-10 | No conversation history yet | Issue 3 consecutive commands. Check `chrome.storage.local` for any `conversation` or `history` keys. | No history stored (Phase G). Each COMMAND is single-turn. |

**Pass criteria for Phase E (full):** all `doc/TO-QA.md` §Deliverable #5 CR/QA items pass on Termux **and** PC-E-1, PC-E-2, PC-E-3, PC-E-4, PC-E-6 pass on PC (PC-E-5/PC-E-7/PC-E-8/PC-E-9/PC-E-10 recommended). PC-E-1 (shopping round-trip) and PC-E-4 (VLM fallback) are the hackathon demo anchors — if either fails, Phase E is not demo-ready.

---

## Phase F — Actions & Form Filling (PC checks)

Real click, navigate, form fill (React/Vue/Angular controlled-component detection), dropdown select, confirmation flow, sensitive-field masking. **This is the "make Diamond *do* things" phase — shopping and job-application demo scenes depend on it.**

| # | Test | Steps | Expected |
|---|------|-------|----------|
| PC-F-1 | click works on real page | On a shopping demo page, say "click the add to cart button". | LLM returns `{action:"click", elementIndex:N}`. Content resolves element, `scrollIntoView`, `.click()`. Button activates (cart count increments). |
| PC-F-2 | navigate same-origin | On a multi-page demo, say "go to the checkout page" (internal link). | `location.href` changes to the checkout URL. Page navigates. |
| PC-F-3 | navigate cross-origin | Say "open google.com". | `window.open('https://google.com','_blank')` opens a new tab. Current tab unchanged. |
| PC-F-4 | fill on React form | On a React checkout form, say "fill the email field with test@example.com". | `nativeInputValueSetter` used. React state updates (the field shows the value in React DevTools, and a subsequent submit includes it). |
| PC-F-5 | fill read-only fails gracefully | Say "fill the order total field" (a read-only display field). | Diamond speaks "I couldn't fill that field. It may be read-only or disabled." No uncaught exception, no partial write. |
| PC-F-6 | select dropdown option | On a form with a `<select>`, say "choose United States from the country dropdown". | `selectOption` finds the matching `<option>`, sets `element.value`, dispatches `change`. Dropdown visibly updates. |
| PC-F-7 | confirmation flow (shopping) | On a checkout page, say "submit this order". | LLM returns `confirm` schema. Diamond speaks "This will submit your order. Say 'confirm' to proceed." User says "confirm". Pending action executes (form submits or button clicks). |
| PC-F-8 | confirmation cancel | After the confirm prompt, say "cancel" instead. | Diamond speaks "Action cancelled." Pending cleared. No action executed. |
| PC-F-9 | sensitive-field masking (password) | On a login form, say "fill the password field with my password" (LLM may return the value). | Diamond speaks a masked read-back (never the full password). Asks for verbal confirm. Fills only after confirm. |
| PC-F-10 | sensitive-field masking (CC) | On a payment form, say "fill the card number with 4111111111111111". | Diamond speaks "Filling card ending in 1111. Say 'confirm' to proceed." Last-4 only. |
| PC-F-11 | javascript: URL refused | (Edge case) Say "navigate to javascript:alert(1)" (if the LLM ever returns that). | Diamond refuses, speaks an error string. No script executes. |
| PC-F-12 | error UX (element not found) | Say "click button number 999" (out of range). | Diamond speaks "I couldn't find that element on the page. The page may have changed." No crash. |

**Pass criteria for Phase F (full):** all `doc/TO-QA-PHASE-F.md` CR/QA items pass on Termux **and** PC-F-1, PC-F-4, PC-F-7, PC-F-9 pass on PC (PC-F-2/PC-F-3/PC-F-5/PC-F-6/PC-F-8/PC-F-10/PC-F-11/PC-F-12 recommended). PC-F-4 (React fill) and PC-F-7 (confirm flow) are the shopping-demo anchors; PC-F-9 (password masking) is non-negotiable for trust.

---

## Phase G — Context & Profile (PC checks)

Conversation persistence across page navigations, active-goal tracking, "where was I?" recall, profile-based fills (labels-only to LLM), browser-restart session clear. **Phase G is the privacy-critical phase — the PII-never-to-LLM rule is the hardest constraint in the project.**

| # | Test | Steps | Expected |
|---|------|-------|----------|
| PC-G-1 | Conversation persists across pages | On a shopping site, say "find me a blue shirt". Diamond responds. Navigate to the product page. Press Alt+D, say "add this to cart". | Diamond references the prior turn ("the shirt you found") — history was preserved across the navigation. The COMMAND prompt included the conversation. |
| PC-G-2 | Active goal tracked | Say "I'm looking for a blue shirt under $40". Then issue 2 unrelated commands. Then say "where was I?". | Diamond speaks the active goal ("buying a blue shirt under $40") + the last 2 conversation turns. Goal was stored in `session.activeGoal`. |
| PC-G-3 | clear context | Say "clear context". Then say "where was I?". | Diamond responds "Context cleared." First. Then "I don't have any recent context." Session (conversation + goal + formState) cleared; profile preserved. |
| PC-G-4 | Profile-based fill (address) | (Pre-condition: save an address as "Home" via options page or a "remember my address as Home" command.) On a checkout form, say "fill my shipping address with Home". | LLM returns `fill` with `value: profile:address:Home`. Content resolves locally to the saved `lines`. Fields filled. **Network tab shows the Fireworks request body contains the label "Home" but NOT the address lines.** |
| PC-G-5 | PII never to LLM (privacy gate) | Fill `formState` with `{ email: "test@example.com", phone: "555-1234" }` (via a prior fill command). Issue a new COMMAND. Inspect the Fireworks request body in DevTools Network tab. | The request body's `messages` array contains the system prompt, conversation, and page structure — but **the strings "test@example.com" and "555-1234" do NOT appear anywhere in the request body.** Only labels flow. This is the §6 / §5.3 gate. |
| PC-G-6 | Browser restart clears session | Issue several commands (build history + goal). Restart Chrome. Re-invoke Diamond. | Session is empty (no history, no goal). Fresh start. `diamond_profile` still has saved addresses/links (preserved). |
| PC-G-7 | Max 10 turns (FIFO) | Issue 12 consecutive commands. Inspect `chrome.storage.local.diamond_session.conversation`. | Exactly 10 turns stored. The oldest 2 were dropped (FIFO). No unbounded growth. |
| PC-G-8 | Profile persists across restart | Save a profile (address "Home"). Restart Chrome. Check `chrome.storage.local.diamond_profile`. | Profile still present. `onStartup` cleared session but NOT profile. |

**Pass criteria for Phase G (full):** all `doc/TO-QA-PHASE-G.md` CR/QA items pass on Termux **and** PC-G-1, PC-G-4, PC-G-5, PC-G-6 pass on PC (PC-G-2/PC-G-3/PC-G-7/PC-G-8 recommended). **PC-G-5 (PII never to LLM) is non-negotiable** — if any PII string appears in the Fireworks request body, Phase G does NOT merge and is NOT demo-ready. This is the privacy contract with the user.

---

## Phase H — Demo Polish & Testing (PC checks)

Extension loads cleanly, 3 demo scenes rehearsed and working, error UX verified, safety net tested, README accurate, no console errors. **This is the hackathon submission gate — everything must be demo-ready.**

| # | Test | Steps | Expected |
|---|------|-------|----------|
| PC-H-1 | Extension loads cleanly | Load `.output/chrome-mv3/` as unpacked. Check `chrome://extensions`. Open DevTools console. | No red badges. No errors on load. No warnings about missing permissions. |
| PC-H-2 | Scene 1 — News skim (BBC) | Navigate to BBC News. Press Alt+D, say "summarize this page". Press Alt+D, say "list the main headlines". Press Alt+D, say "go to the first article". | Diamond speaks a one-sentence summary. Lists 3–5 headlines. Navigates to the first article. Total ≤ 1 min. |
| PC-H-3 | Scene 2 — Shopping (Amazon) | Navigate to an Amazon product page. Press Alt+D, say "what's on this page?". Press Alt+D, say "find me the cheapest laptop stand on this page". Press Alt+D, say "add the cheapest to cart". | Diamond summarizes the product. Lists options with prices. Clicks Add to Cart. Cart total spoken. Total ≤ 2 min. |
| PC-H-4 | Scene 3 — Form filling (job application) | Navigate to a job application form. Press Alt+D, say "fill my contact info". Confirm profile fill. Press Alt+D, say "what roles can I pick?". Press Alt+D, say "select Full Stack Engineer". Press Alt+D, say "submit the application". Confirm. | Diamond fills fields from profile. Lists dropdown options. Selects the role. Triggers confirmation on submit. Total ≤ 2 min. |
| PC-H-5 | Error UX — mic blocked | Block mic permission. Press Alt+D. | Diamond speaks: "Microphone access is blocked. Please allow mic permissions." No uncaught exception. |
| PC-H-6 | Error UX — element not found | Say "click button number 999" (out of range). | Diamond speaks: "I couldn't find that element on the page. The page may have changed." |
| PC-H-7 | Safety net — irreversible action | On a page with a submit button labeled "Submit Application", say "click the submit button". | Safety net wraps it in confirm flow: "This will submit the application. Say 'confirm' to proceed." even if the LLM didn't use `confirm` schema. |
| PC-H-8 | Latency logging | Issue a command. Open DevTools console. | `[Diamond] STT: <ms>ms`, `[Diamond] LLM: <ms>ms`, `[Diamond] Total: <ms>ms` logged. Latency is reasonable (< 5s total for a simple command). |
| PC-H-9 | README accuracy | Follow README.md instructions from scratch on a fresh machine. | Clone → `pnpm install` → `pnpm dev` → load unpacked → options → API key → Alt+D works. README matches reality. |
| PC-H-10 | No console errors across all 3 scenes | Run all 3 demo scenes back-to-back. Check DevTools console after each. | No errors, no uncaught exceptions, no React/framework warnings. Clean console. |
| PC-H-11 | Demo timer | Time all 3 scenes end-to-end. | Total ≤ 7 minutes. If over, trim Scene 2 (shopping) or Scene 3 (form filling). |
| PC-H-12 | Backup sites | If Amazon or BBC blocks the extension: switch to Wikipedia (summarize this page) or GitHub (list the links). | Diamond works on backup sites. Fallback is documented in demo script. |

**Pass criteria for Phase H (full):** all `doc/TO-QA-PHASE-H.md` CR/QA items pass on Termux **and** PC-H-1, PC-H-2, PC-H-3, PC-H-4, PC-H-10 pass on PC (PC-H-5 through PC-H-12 recommended). **PC-H-1 (clean load) and PC-H-10 (no console errors) are non-negotiable** — if the extension has errors on load or during scenes, Phase H is not demo-ready. **PC-H-11 (demo timer ≤ 7 min)** is the submission gate — if the demo runs over, it must be trimmed before submission.

## Phase J — Activation mode, popup UI, Alt+S toggle, visibility-gated PAGE_LOAD (PC checks)

Phase E shipped push-to-talk command mode. Phase J layers three new activation surfaces (popup, hands-free mode, Alt+S global toggle) and the visibility-gated PAGE_LOAD fix that prevents Chrome session restore from speaking page summaries for hidden tabs (PC-V-1). All five PC checks below are gated on the existing four-gate suite passing in this turn (typecheck, tests, build, secret scan).

### Visibility

| # | Test | Steps | Expected |
|---|------|-------|----------|
| PC-V-1 | Session restore does not speak summaries for inactive tabs | Restore a Chrome session with 6+ tabs. Click into each tab in turn. Open Options → Diagnostics → Refresh the log buffer. | No `tts\|PAGE_LOAD summary spoken` line for any tab until it becomes the active tab. `page_load\|deferred — tab not visible` fires once per inactive tab at script load. `page_load\|visibility restored — sending now` fires the moment the user brings the tab forward; the `speak()` follows on the same line group. |

### Popup

| # | Test | Steps | Expected |
|---|------|-------|----------|
| PC-P-1 | Toolbar icon → popup → click Hands-Free radio | Click the Diamond icon. Click the Hands-Free Mode radio row. | Row toggles to selected (border + bg tint). Status text reads `Hands-free mode.` `storage\|mode changed` log fires in the SW. `voice\|MODE_CHANGED broadcast received` fires in the active tab's content script. `tts\|plain speech response` shows the spoken confirmation (from `ERRORS.MODE_HANDS_FREE_ON`). |
| PC-P-2 | Toggle back to Command via popup while a hands-free loop is armed | With hands-free running and the recognizer active, click the Command mode radio row. | Active tab's content script receives MODE_CHANGED. `voice\|hands-free stopping` (or `utterance callback requested stop`) fires in the next onresult cycle — the loop arms down within at most one utterance. |

### Alt+S

| # | Test | Steps | Expected |
|---|------|-------|----------|
| PC-A-1 | Alt+S in active tab | Press Alt+S in any regular page (`https://example.com`). | `command\|manifest command received` with `command: "toggle-diamond-mode"`. `storage\|mode toggled` with `{from, to}`. Terse spoken confirmation. If switching back to command and a hands-free loop is armed, the `voice` logger shows the loop-teardown path. |
| PC-A-2 | Alt+S on a chrome:// page (chrome.commands may not fire there) | Open `chrome://newtab/` if available; press Alt+S. | Content-script capture-phase keydown forwarder fires. SW `onMessage` handler `TOGGLE_MODE` picks up. Same observable effect as PC-A-1 — proves the content-script fallback. |

### Hands-free lifecycle

| # | Test | Steps | Expected |
|---|------|-------|----------|
| PC-HF-1 | Arms once, multiple utterances flow without re-press | Activate hands-free mode. Speak one command. Wait for the spoken response. Speak a second command. | `voice\|hands-free started` fires exactly once. `stt\|hands-free transcript` fires once per utterance. No second Alt+D required. `voice\|hands-free session` Stopwatch keeps ticking throughout. |
| PC-HF-2 | 60s silence → sleep | Activate hands-free mode. Wait 60s without speaking. | `voice\|hands-free stopping` fires. Sleep beep plays. `voice\|hands-free session` Stopwatch stops with reason `user-stopped` (the sleep-timeout cleanup reuses the helper). |

### Cold SW

| # | Test | Steps | Expected |
|---|------|-------|----------|
| PC-B-1 | Cold-start activation works | Fresh install (or browser restart). Open any page. Press Alt+D. | Content-script `ACTIVATE` listener fires. SW wakes cleanly. No `chrome.action.onClicked` log noise (popup-replaced handler is silent — that's intentional). |

**Pass criteria for Phase J (full):** PC-V-1, PC-P-1, PC-P-2, PC-A-1, PC-A-2, PC-HF-1, PC-HF-2, PC-B-1 all pass on PC. **PC-V-1 is the regression gate for the Chrome session restore bug** — it must keep passing as we add navigation listeners in the future.
