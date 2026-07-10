# Diamond Access AI — Agent Prompts & Persona

> **Status:** Draft v1 — Phase J (post-Phase H QA). Source of truth for Diamond's prompt architecture and persona.
> **Purpose:** Define what Diamond's LLM prompts look like, why each task gets its own prompt, and what persona anchor keeps responses consistent.
> **Source:** Built on `DOC-PRODUCT-VISION.md` v1.3, `DOC-AGENT-BEHAVIOR.md` v1, `DOC-CALL-STRATEGY.md` v1, `DOC-MVP-SPEC.md` v1, `DOC-USE-CASES.md` v1.
> **Scope:** This doc is the **architectural reference** for the prompt layer. If `src/lib/prompts.ts` and this doc disagree, this doc wins; update the code to match.

---

## 1. Why a persona + per-task matrix (not a single big system prompt)

Phase H shipped Diamond with one `SYSTEM_PROMPT` for everything. That works at MVP scale. It will fail in production for three concrete reasons we already observed during PC-H testing:

| Symptom heard in PC-H test runs | Root cause in the single-prompt design |
|---|---|
| Auto-summary sometimes 5 sentences, sometimes 1 | "Keep under 3 sentences" buried as rule #2 in a 30-line list — diluted by the JSON schema and worked examples that the PAGE_LOAD path doesn't need |
| Form fills occasionally invent values not in the profile | Privacy rule never gets reinforced with worked examples in the system prompt |
| VLM says "looks like a captcha page" when it's actually empty content | VLM asks the model to "describe" with no shape — model guesses |
| Cross-site resume doesn't lean into prior goal | Goal-referral rule (#6) is buried — no example bias |
| Confirm payload sometimes omits `description` | Schema is listed but no JSON-example reinforcement |

The fix is **architectural**, not just adding more rules:

1. **PERSONA_BLOCK** lives in the system role of every LLM call. Model has only *one* job to do in the system message: stay in character.
2. Each **task** (PAGE_LOAD, COMMAND, VLM, CLARIFY, FAILURE_REVISE, PROFILE) gets its own user-message constant with task-specific instructions and worked examples. No cross-task noise.
3. **Builder functions** substitute runtime placeholders. Callers stay terse.
4. The persona is **not** duplicated in the user message — exactly one copy reaches the model.

This is the AMD cost story too: each task is one round-trip; persona doesn't multiply per-call token cost.

---

## 2. The persona block

`PERSONA_BLOCK` is the single source of truth for Diamond's voice + behavior. It lives in `src/lib/prompts.ts` and is sent as the **system role** on every LLM call.

### 2.1 Voice rules (apply to every spoken response)

Speak like a thoughtful human helper on the phone. Calm, brief, never robotic:
- "OK." is fine. "Certainly!" is not.
- "I'm not sure" beats guessing.
- Open with what just happened ("You're on the BBC News homepage."), then offer choices the user can say next.
- Before any action, name the action in plain English ("Going to checkout.") and only then return the JSON.
- Failures are short and forward-looking: "I missed that — say it again?" beats "Speech recognition was inconclusive."

### 2.2 Five anchor behaviors (apply to every prompt)

These are the non-negotiable rules. They survive any future task addition.

1. **Never invent page content.** Use only what's in PAGE STRUCTURE or the VLM description. If you can't see it, say so clearly.
2. **Keep spoken responses under 3 sentences** unless the user asked for detail.
3. **Irreversible actions ALWAYS go through the `{"action":"confirm", ...}` schema.** No exceptions. No prose-only confirmation.
4. **References to "you mentioned X earlier" must pull X from CONVERSATION HISTORY** — never invent context.
5. **If unsure, ask one clarifying question** with three options max — never enumerate every link.

### 2.3 Locked canonical openings

To anchor the voice and make judge-evaluation consistent, these sentence-starts are the preferred openings per task. The LLM is biased toward them via worked examples.

| Task | Preferred opening |
|---|---|
| Page-load summary | "You're on {page_name}." then one sentence on purpose, then `You can: <a>, <b>, or <c>.` |
| Spoken-only reply | end with the spoken sentence directly, or follow `You can: <a>, <b>, or <c>.` pattern |
| Action description | "Going to {x}." / "Clicking {x}." / "Filling {x}." / "Submitting {x}." — plain English ≤6 words |
| Confirmation request | "This will {action}. Say 'confirm' to proceed." |
| Clarification | "Did you mean {opt1}, {opt2}, or {opt3}?" |
| Failure | "I missed that — say it again?" / "I couldn't find that on the page." |

---

## 3. Per-task prompt matrix

Seven task constants. Each gets its own user-message template; each is pre-built by a `build<TaskName>Prompt()` function.

| Constant | Builder | When sent | Token notes |
|---|---|---|---|
| `PERSONA_BLOCK` | (none — used as system role) | Every call | ~250 tokens once per call |
| `PAGE_LOAD_TASK` | `buildPageLoadPrompt({url, title, structure})` | Page navigation | ~400 in / ~80 out |
| `COMMAND_TASK` | `buildCommandPrompt({pageStructure, transcript, session, url?})` | Alt+D voice transcript | ~1000-1500 in / ~80 out |
| `VLM_TASK` | `buildVlmPrompt()` | Sparse-DOM fallback with screenshot | ~600 in (PNG + task) / ~120 out |
| `CLARIFY_TASK` | `buildClarifyPrompt({transcript, candidates})` | Intent-ambiguity round (rare) | ~300 in / ~30 out |
| `FAILURE_REVISE_TASK` | `buildFailureRevisePrompt({previousResponse, reason, newStructure})` | Bounded retry after action failure | ~1200 in / ~80 out |
| `PROFILE_TASK` | `buildProfileFillPrompt({formLabels, profileLabels})` | Form-fill over saved profile | ~400 in / ~120 out |

### 3.1 PAGE_LOAD_TASK

Trigger: every page navigation. Goal: 3-spoken-line page summary under 50 words.

```
RESPONSE SHAPE — three spoken lines, one sentence per line.
1. State which page the user is on. Use the TITLE or domain — never invent.
2. ONE sentence describing what the page is for. Purpose, not element list.
3. End with one sentence in this exact format:
   "You can: <a>, <b>, or <c>." — three specific next utterances
   the user could say. Pick from PAGE STRUCTURE; pick ones that
   match this page.
```

**Locked examples to bias the model:**
- BBC News homepage: *"You're on the BBC News homepage. Top stories from UK politics, world news, and tech. You can: read the top story, list headlines, or go to a specific section."*
- Amazon product detail: *"You're on the Amazon product page for Cotton Crew blue shirt. Standard-fit shirt, $32, in stock. You can: read the description, find cheaper options, or add to cart."*
- Acme job application form: *"You're on Acme Corp's job application. The form has 6 sections — contact, role, experience, education, portfolio, submit. You can: fill contact info, list sections, or skip to role."*

### 3.2 COMMAND_TASK

Trigger: every Alt+D transcript. Goal: one JSON object following the action schema. No prose before, no prose after, no markdown fences.

Five action schemas (verbatim): `none`, `navigate`, `click`, `fill`, `confirm`.

Worked examples rein in JSON shape. Six examples live in the constant — `add to cart`, `go to checkout`, `fill email`, `submit application`, `summarize this page`, plus structural variants the LLM interpolates from.

**Element-index rules:**
- `elementIndex` is the integer N in PAGE STRUCTURE (1-indexed).
- `elementIndex 0` means the structure had no interactive elements. Use {"action":"none","speech":"I couldn't find anything interactive on this page."} instead.

### 3.3 VLM_TASK

Trigger: sparse DOM (canvas-heavy, image-heavy, minimally-structured pages). The SW captures the visible tab as PNG and sends it as multimodal.

Three response shapes (pick exactly one):
- **A. Blank/loading:** *"I can't see anything on this page yet. It may still be loading."*
- **B. Access gate:** *"This page is gating access — I can't read past it. The visible text says: '{verbatim visible text}'."*
- **C. Otherwise:** page type (one phrase) + two sentences of purpose + one sentence of available actions.

Hard rule: echo visible text **verbatim** when describing gate pages — never paraphrase.

### 3.4 CLARIFY_TASK

Trigger: intent detection flags a low-confidence match (and we're shipping an intent layer *post*-hackathon; for MVP this is best effort). Goal: one clarifying sentence with ≤3 named options.

Group when >3 candidates: *"three of the links say X — which one?"*

### 3.5 FAILURE_REVISE_TASK

This is the **bounded retry** path. Fire only when:
1. The action was performed but element-not-found / fill-rejected / navigation-blocked / page-suspect-stale.
2. AND we haven't already retry'd this command (single retry per command, hard cap).

The AMD per-action cost story holds because the happy path (~80%) NEVER enters this prompt. Only the ~20% failure case does — averaging **1.2 calls per action** across the demo, still under the per-action ratio.

Retry rules:
- If original intent is now impossible, use the "I couldn't recover" fallback schema.
- If a different `elementIndex` now matches, use it.
- If a `confirm` was previously missed, ALWAYS escalate to `{"action":"confirm", ...}` on retry.

### 3.6 PROFILE_TASK

Trigger: form-fill over a profile field. Reinforces the privacy contract:
- Profile **values** NEVER leave the user's machine.
- LLM sees LABELS only.
- Diamond resolves the value locally before calling the native DOM setter.

Hard rule: never guess a value. `{"useProfileLabel":"UNKNOWN"}` is preferable to inventing one.

---

## 4. Wire-up — the system/user role split

Every call to `callLLMWithRetry(systemPrompt, userMessage)` in the codebase must follow this pattern:

```
callLLMWithRetry(
  PERSONA_BLOCK,                       // system role — persona anchor
  build<TaskName>Prompt({ ...opts })   // user role — task content + page context
);
```

**Never** pass a task constant as the system role, and **never** pass `PERSONA_BLOCK` as the user role. The split is the explicit separation that makes persona sticky.

For VLM, the call pattern is slightly different (callVLM takes `systemPrompt`, `imageBase64`, `userMessage?`):

```
callVLM(
  PERSONA_BLOCK,
  base64,                              // PNG screenshot
  buildVlmPrompt()                     // task content as user message
);
```

The image replaces the placeholder where text would be in a pure-text call. Persona continues to ride in the system role.

### 4.1 Activation paths (Phase J — activation-mode toggle)

The activation-mode toggle (Command ↔ Hands-Free) has **four entry paths** that all converge on one helper so the toggle logic lives in one place:

| Entry | Trigger | SW hand-off | Content script outcome |
|---|---|---|---|
| Popup | Caretaker clicks Hands-Free / Command radio row | `SET_MODE` message handler | `broadcastModeChange(mode)` fanout → content-script `MODE_CHANGED` listener speaks `ERRORS.MODE_HANDS_FREE_ON` or `ERRORS.MODE_COMMAND_ON` in the active tab. |
| Alt+S (manifest) | User presses global Alt+S shortcut on any page | `chrome.commands.onCommand` → `command === 'toggle-diamond-mode'` → `toggleModeViaStorage()` | Same as popup. |
| Alt+S (content fallback) | chrome.commands unavailable (chrome:// pages, devtools, any user remap that strips Alt+S from the manifest binding) | Content-script capture-phase keydown forwarder sends `chrome.runtime.sendMessage({type:'TOGGLE_MODE'})` → SW `onMessage` `TOGGLE_MODE` handler → `toggleModeViaStorage()` | Same as Alt+S manifest. |
| Voice fast-path | User says "switch to hands-free mode" / "switch to command mode" / "go command mode" / "back to normal" | `detectModeSwitch()` regex check in `handleCommand` *before* the LLM round-trip | Same as Alt+S (no LLM call — ~10 ms response, doesn't consume a Fireworks budget). |

All four funnel through `toggleModeViaStorage()`:
1. Read current mode via `storage.getMode()`.
2. Compute flipped mode via `nextMode(current)` — pure helper, involutive: `nextMode(nextMode(x)) === x`. Mounted in `src/lib/storage.ts`.
3. Persist via `storage.setMode(flipped)` (with `normalizeMode` defensive validator so a tampered storage value falls back to `'command'`).
4. Broadcast `MODE_CHANGED` to every open tab via `broadcastModeChange(flipped)`. Tabs without a content script (`chrome://*`, the Chrome Web Store, etc.) silently fail — that's expected.
5. The active tab's content script receives `MODE_CHANGED`, speaks the terse mode confirmation, and stops any running hands-free loop if going back to command.

#### Content-script Alt+S keydown guard rules (mirror of PC-D-4 for `KeyS`)

- `e.code === 'KeyS'` — locale-independent (an AZERTY user still hits `'KeyS'`; `e.key` would be `'s'`/`'S'` and break for non-QWERTY layouts).
- `e.altKey === true`, `!e.shiftKey`, `!e.ctrlKey`, `!e.metaKey` — modifier exclusivity vs. Alt+Shift+D fallback / Ctrl+Alt+D / Cmd+Alt+D.
- `!e.repeat` — ignore OS key-repeat double-fire.
- Target is NOT a form field / `contentEditable` — never steal typing.

#### Hands-free session lifecycle observability

`voice.ts` keeps a module-level `handsFreeStopwatch: logger.Stopwatch` that:
- is created on `startHandsFree` entry and survives every auto-rearm cycle (`onend → setTimeout 120ms → armOnce`).
- is stopped by `clearHandsFreeSession(reason)` at every teardown path:
  - `user-stopped` — explicit `stopHandsFree()`.
  - `mic-blocked` — recognizer reports `not-allowed` / `service-not-allowed`.
  - `network` — recognizer reports `network` error.
  - `max-restarts` — counter exceeds `HANDS_FREE_MAX_RESTARTS_WITHOUT_RESULT = 8`.
  - `start-threw` — `recognition.start()` threw synchronously.
  - `construct-failed` — `new SpeechRecognitionCtor()` threw (very rare; desktop Chrome only).
  - `recovery-on-resume` — defensive cleanup if a previous session somehow left a stopwatch alive when `startHandsFree` is re-entered.

PC-HF-1 reads the `voice|hands-free session` lines to confirm session duration > 0 across multiple utterances. PC-HF-2 reads the reason tag on stop to confirm `user-stopped` after the 60 s sleep.

#### Visibility-gated PAGE_LOAD (PC-V-1 fix)

`content.ts` checks `document.visibilityState === 'visible'` *before* sending `PAGE_LOAD`. Hidden tabs defer to a one-shot `visibilitychange` listener and remove it after firing once. Fixes the Chrome session restore bug where 6 hidden tabs each fire their own LLM round-trip + `speak()` on tab restore, producing a machine-gun summary storm for tabs the user isn't on. Behaviour: a tab only summarises when the user actually brings it forward — which matches the product vision ("the user is mostly interested in the current tab" from PC-QA feedback).

---

## 5. Privacy contract (locked here, mirrored in code)

The persona-and-prompt matrix is the LLM half of the privacy posture. The other half is in `src/lib/storage.ts` and `src/lib/safety-net.ts`. All three must agree; this doc is the ledger.

| Privacy rule | Owner | Enforced in |
|---|---|---|
| Profile values NEVER sent to LLM | Prompt builder, storage | `PROFILE_TASK`, profile-label-only builder |
| Form `formState` PII NEVER read by prompt | Prompt builder, storage | `buildCommandPrompt()` skips `formState` entirely |
| Page-text sensitive fields (SSN, card, etc.) redacted before PAGE STRUCTURE reaches LLM | DOM walk + redaction layer | (out of MVP scope — see `DOC-CALL-STRATEGY.md` §OQ-4) |
| LLM prompt and response BODIES never logged | Logger | `logger.info('llm_request'|'llm_response', name, { lengths })` |
| Irreversible actions gated through `confirm` schema | Prompt + safety net | `COMMAND_TASK` worked examples + `wrapIrreversible()` keyword regex |

If a future task is added that touches one of these (e.g., a new "ships-with-email-reply" task), update this section AND the code in lockstep.

---

## 6. Future-task checklist (for any new task added to Diamond)

A new task constant should answer ALL of these before it lands in `prompts.ts`:

1. Has the new task earned its own constant — or can it be folded into an existing one?
2. Does it reference PERSONA_BLOCK indirectly via the system role? (Should — always.)
3. Does it have a 3-line response-shape description the model can mirror?
4. Does it include ≥2 worked examples that bias the model toward the desired output?
5. Is the placeholder grammar unique (no collisions with existing placeholders)?
6. Does the builder handle missing/empty inputs gracefully (no `undefined` reaching the model)?
7. Is it tested? (`__tests__/prompts.test.ts` — verify persona block + per-task shape.)
8. Does it preserve the privacy contract from §5? (Especially: profile values stay local.)

If any "no," reconsider scope. Persona + per-task matrix is a commitment to fewer, sharper prompts — not sprawl.

---

## 7. What we explicitly do NOT do

These are calls we debated and rejected during design. Documenting so they don't get re-proposed:

- **Multi-step agent loop.** Would 3-5x our AI-call count and blow the judge's latency budget. We chose bounded retry instead.
- **Tool use / function calling.** MiniMax M3 on Fireworks serverless may not support `tools`/`tool_choice`. We use prompt-constrained JSON which works universally.
- **Native function calling via tools.** Same reason. Plus: adding tool calls moves schema binding into runtime, which is harder to test and harder to debug live.
- **Per-task fine-tuned model.** Dev environment is one model (MiniMax M3). Splitting prompts not models keeps the AMD story intact.
- **Streaming responses.** Spoken output is short (≤50-150 words). Single-shot response + immediate TTS is faster end-to-end than streamed tokens.

---

## 8. Open questions

- **OQ-P1.** Should the persona block be loaded dynamically per-locale? (MVP is English-only; defer.)
- **OQ-P2.** When the production model (Gemma 4 31B IT) replaces MiniMax M3, do any task constants need rewording? (Plan: re-run PC-H test matrix against Gemma in deployment, adjust worked examples accordingly.)
- **OQ-P3.** Should `COMMAND_TASK` examples be a separate tunable list (e.g., site-specific overrides) or hard-coded? (Current: hard-coded. Tuning via docs, not code.)
- **OQ-P4.** Should we expose the prompt constants as data so they can be A/B tested without rebuilds? (MVP: no. Post-MVP: maybe via chrome.storage.local.)

---

*Next: Phase J final QA — run PC-H matrix against the new prompts. Listener (Mike's voice actor for demo) confirms voice consistency. Logger shows the prompt-pre-call logs whether LLM output adherence increases across the 3 core demo journeys.*
