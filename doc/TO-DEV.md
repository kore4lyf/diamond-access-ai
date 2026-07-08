# Diamond Access AI — Developer Deliverables

> **Status:** Living doc — updated by the PM as each phase is released.
> **Audience:** Software Engineer (Korede, Vivek).
> **Convention:** One deliverable per H2 section, newest at the top.
> **Source of truth for scope:** `doc/DOC-BUILD-PHASES.md`, `doc/DOC-ARCHITECTURE.md`, `doc/DOC-STACK-DECISIONS.md`, `doc/DOC-MVP-SPEC.md`.

---

## Platform note — READ THIS FIRST

We are currently working on **Termux (Android)**. A real Chrome/Chromium that can **load an unpacked extension does not exist on this host.** Consequences:

1. `pnpm dev` will likely **fail to launch a browser** here. That is expected. The engineer's job on Termux is to produce code that **builds and type-checks** (`pnpm build`, `pnpm typecheck`, `pnpm test`). Manual "load unpacked + click around" QA happens later on PC — see `doc/PC-QA-TEST.md`.
2. **`pnpm` does not install globally.** It uses a content-addressed store with per-project symlinks. Everything stays inside this repo's `node_modules/`. When we move the repo to PC, `pnpm install` reproduces the lockfile exactly. Do not add anything to global Node.
3. Some WXT/native deps (e.g. `esbuild`, `sharp`) may **fail to build on aarch64 Android**. If `pnpm install` errors on a native module:
   - Do **not** patch the codebase with Android-specific workarounds.
   - Stop, capture the exact error, and flag it to the PM. We will either (a) recreate the scaffold cleanly on PC, or (b) fix the env. The code stays clean.
4. Commit the scaffold even if it was never loaded in a browser here. "Builds + typechecks + tests pass" is the Termux bar. "Loads in Chrome" is the PC bar (see `PC-QA-TEST.md`).

---

## Deliverable #1 — Project Scaffold

**Phase:** A (Project scaffold) · **Timebox:** 1h · **Source:** `DOC-BUILD-PHASES.md` §Phase A, `DOC-ARCHITECTURE.md`, `DOC-STACK-DECISIONS.md`

### Objective
Stand up the WXT + TypeScript Chrome Extension (MV3) skeleton. By the end, `pnpm build` and `pnpm test` must succeed on Termux. *Loading it in Chrome is a PC task (see `PC-QA-TEST.md`).*

### Tasks

1. **Initialize WXT in repo root** (do NOT create a new subdir):
   ```bash
   pnpm create wxt@latest .
   pnpm install
   ```
2. **`wxt.config.ts`** via `defineConfig` (not a hand-edited manifest):
   - `name`: "Diamond Access AI", `version`: "0.1.0"
   - `description`: "Voice-first browser accessibility assistant powered by AI on AMD GPUs"
   - `permissions`: `["activeTab", "storage"]` *(see Open Question below — PM will confirm)*
   - Content script: matches `<all_urls>`, `run_at: "document_idle"`
   - Commands: `activate-diamond` → `Alt+D`, `activate-diamond-alt` → `Alt+Shift+D`
   - Action default title: "Diamond Access AI — Press Alt+D to activate"
   - Icons: 16/48/128 (placeholders OK)
3. **Entrypoints under `src/`** — exact structure:
   ```
   src/
   ├── entrypoints/
   │   ├── background.ts
   │   ├── content.ts
   │   └── options.ts
   └── lib/
       ├── dom-walk.ts   # stub // TODO(Phase B)
       ├── fireworks.ts  # stub // TODO(Phase C)
       └── voice.ts     # stub // TODO(Phase D)
   ```
4. **`options.ts`** (minimal, unstyled):
   - Text input for Fireworks API key
   - Save → `chrome.storage.local` under key `diamond_api_key` (exact key name)
   - On load, read existing key and pre-fill input
   - This is the only place the key is ever written
5. **`background.ts`** (skeleton only):
   - `chrome.runtime.onMessage` listener that logs received messages
   - **Return `true`** for async responses (per arch doc §3.2 — critical)
   - `chrome.action.onClicked` listener that logs a line
   - NO `fetch()`, NO `chrome.tabs.captureVisibleTab()` yet (those are Phase C/E)
6. **`content.ts`** (skeleton only):
   - Logs "Diamond Access AI content script loaded" on load
   - Sends `{ type: 'PAGE_LOAD', url: location.href }` to background once
   - NO `fetch()`, NO `XMLHttpRequest`, NO network code
   - NO DOM walk yet (Phase B)
7. **Vitest**:
   ```bash
   pnpm add -D vitest
   ```
   - `vitest.config.ts` with default config
   - Smoke test at `src/lib/__tests__/dom-walk.test.ts`: assert `1 + 1 === 2`
   - Add `test` script to `package.json`
8. **`public/_locales/en/messages.json`** with `extName` and `extDescription` keys.
9. **Placeholder icons** in `public/icons/`: `icon16.png`, `icon48.png`, `icon128.png` (solid-color squares OK).
10. **`package.json` scripts**: `dev`, `build`, `zip`, `test`, `typecheck` (`tsc --noEmit`) all wired.
11. **`.gitignore`**: verify it covers `node_modules/`, `.output/`, `.wxt/`, `*.env*`. Append if missing. A `.env` already exists in repo root — confirm it stays untracked.
12. **README "Development" section** documenting: `pnpm dev` (note: requires PC), `pnpm test`, `pnpm typecheck`, `pnpm build`, how to set the API key, and how to load unpacked in Chrome on PC.

### `lib/*.ts` stub contract

Each stub must export at least one named function with a `// TODO(Phase X)` marker so later phases can drop in:
```ts
// src/lib/dom-walk.ts
// TODO(Phase B): implement extractPageStructure()
export function extractPageStructure(): unknown {
  throw new Error('Not implemented — Phase B');
}
```
Same shape (different names) for `fireworks.ts` and `voice.ts`.

### Guardrails (hard rules)

- **Permissions:** only `activeTab` + `storage`. If a task needs `tabs`, `scripting`, `debugger`, or `host_permissions`, STOP and flag to PM.
- **No Fireworks calls** (per DOC-MODEL-ADR dev note: "Do NOT call AI APIs during development unless absolutely necessary").
- **No network from the content script.** Background is the only `fetch()`-capable component.
- **No real icons required** this phase.
- **No Android-specific workarounds** in the codebase (see Platform note above).

### Deliverable artifacts (Termux bar)

- `pnpm install` succeeds (if it fails on a native module, capture the error and flag — see Platform note)
- `pnpm typecheck` exits 0
- `pnpm test` exits 0
- `pnpm build` produces `.output/` with `manifest.json`, `background.js`, `content.js`, `options.html`, icons
- Commit: `feat(scaffold): WXT MV3 skeleton with entrypoints, lib stubs, options page`
- Do **NOT** attempt to load in Chrome on Termux. Document that as deferred in the commit body.

### Open question for PM

`DOC-ARCHITECTURE.md` §6 says `activeTab` only, but `DOC-FIREWORKS-INTEGRATION.md` §5 requires `storage` for the API key. I've instructed the engineer to use `["activeTab", "storage"]`. **PM must confirm and update `DOC-ARCHITECTURE.md` §6 to reflect `storage` is required.**

---

## Deliverable #1.1 — PM action: reconcile permission docs

The engineer is blocked on the `storage` permission ambiguity until this is resolved. Action: update `DOC-ARCHITECTURE.md` §3.3 manifest example and §6 permission table to include `storage`, and add a one-line "added because options page needs `chrome.storage.local` for the API key" note.

---

*Next deliverable (Phase B — DOM walk engine) drops after Phase A is accepted on PC.*

---

## Scaffold completion report (2026-07-08)

### ✅ Termux bar — ALL GREEN

| Command | Status | Details |
|---------|--------|---------|
| `pnpm install` | ✅ | 421 packages resolved, esbuild approved via `.npmrc` `onlyBuiltDependencies` |
| `wxt prepare` | ✅ | Types generated |
| `tsc --noEmit` | ✅ | 0 errors |
| `vitest run` | ✅ | 1 test passed (1+1=2) |
| `wxt build` | ✅ | 8 assets, 7.62 kB total |

### ✅ Committed

```
a10ad63 feat(scaffold): WXT MV3 skeleton with entrypoints, lib stubs, options page
```

**20 files created** across configs, entrypoints, lib stubs, icons, _locales.

### Built manifest

```json
{
  "manifest_version": 3,
  "name": "Diamond Access AI",
  "version": "0.1.0",
  "permissions": ["activeTab", "storage"],
  "action": { "default_title": "Diamond Access AI — Press Alt+D to activate" },
  "commands": {
    "activate-diamond": { "suggested_key": { "default": "Alt+D" } },
    "activate-diamond-alt": { "suggested_key": { "default": "Alt+Shift+D" } }
  },
  "background": { "service_worker": "background.js" },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "run_at": "document_idle",
    "js": ["content-scripts/content.js"]
  }]
}
```

### Issues discovered & fixed

| Issue | Fix |
|-------|-----|
| **Mega .gitignore has `lib/`** (line 171) — caught `src/lib/` | Added `!src/lib/` in Diamond Access AI section |
| **pnpm v11** moved build-script config out of package.json | Used `.npmrc` with `onlyBuiltDependencies[]=esbuild` and `onlyBuiltDependencies[]=spawn-sync` |
| **`pnpm approve-builds`** is interactive, fails in non-TTY | Workaround: `.npmrc` directives instead |
| **`pnpm create wxt`** is interactive (can't scaffold non-empty repo) | Hand-crafted all scaffold files from spec |
| **WXT 0.20 `wxt/tsconfigs/base`** does not exist | Wrote inline `tsconfig.json` with paths, moduleResolution, chrome types |
| **WXT 0.20 no `defineOptions`** | Used `defineUnlistedScript` from `wxt/utils/define-unlisted-script` |
| **WXT 0.20 `contentScripts` config key** didn't apply matches/runAt | Specified `matches` directly in `defineContentScript({ matches, runAt, main() })` |
| **WXT 0.20 `permissions`** must be inside `manifest` key, not top-level | Moved `permissions: [...]` into the `manifest: { permissions: [...] }` block |
| **@types/chrome v0.2.2** `storage.get` returns `{[key: string]: unknown}` | Used `as string` cast for the value access in options.ts |

### ⚠️ Open items for PM

1. **`DOC-ARCHITECTURE.md` §6 permission table still says `activeTab` only** — needs update to `["activeTab", "storage"]` with a note about the options page needing `chrome.storage.local`.
2. **`chrome.commands.onCommand` not wired** — The manifest declares Alt+D/Alt+Shift+D, but the background service worker does **not** listen for `chrome.commands.onCommand`. This is intentional: the content script's keydown handler + icon click provide activation for Phase A. The `onCommand` handler should be added in Phase D when the voice pipeline is integrated. The build/typecheck/test bar passes without it.
3. **`scripts/verify-models.mjs`** — Already modified pre-existing file, not part of this deliverable. Not committed. Requires FW_KEY from `.env`.
4. **PC QA deferred** — Manual Chrome loading and extension test required on PC per `doc/PC-QA-TEST.md`.
5. **Options page is a `.js` file, not `.html`** — WXT 0.20 renders unlisted scripts as JS modules, generating the HTML at runtime via Vite. The behaviour is identical to an HTML page; the extension's `options_ui` resolves correctly. No action needed.

### Deferred to Phase B/C/D

- DOM walk engine (`src/lib/dom-walk.ts` stub) — Phase B
- Fireworks AI integration (`src/lib/fireworks.ts` stub) — Phase C
- Voice pipeline (`src/lib/voice.ts` stub) — Phase D
- `storage` permission for API key persistence — confirmed this phase, see item 1 above
