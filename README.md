# Diamond Access AI

A voice-first Chrome extension that makes any website fully accessible to blind and low-vision users. One keyboard shortcut → ask anything about the page → hear the answer.

**Built for AMD Developer Hackathon: ACT II** | July 6–11, 2026 | Unicorn Track

---

## How it works

1. Press **Alt+D** anywhere on any webpage
2. Diamond reads the page structure via DOM walk
3. AI (Gemma 4 on Fireworks AI / AMD GPUs) understands your command
4. Diamond speaks the answer or performs the action (click, fill, navigate)

## What it can do

- Summarize any page you visit
- List all links and navigation options
- Find products, articles, or specific content
- Fill forms and complete checkouts
- Navigate between pages
- Remember your context across a session

---

## Project structure

```
diamond-access-ai/
│
├── src/
│   ├── entrypoints/                  # WXT entry points (auto-registered)
│   │   ├── background.ts             # Service worker — API calls, context, message routing
│   │   ├── content.ts                # Content script — DOM walk, voice, action execution
│   │   └── options.ts                # Options page — API key entry, saved to chrome.storage.local
│   │
│   ├── lib/                          # Shared and domain logic
│   │   ├── dom-walk.ts               # Page structure extraction (DOM → tokens)
│   │   ├── dom-walk.test.ts          # Unit tests for DOM extraction
│   │   ├── fireworks.ts              # Fireworks AI API client (Gemma 4)
│   │   ├── fireworks.test.ts         # Unit tests for API client
│   │   ├── voice.ts                  # STT (Web Speech API) + TTS + audio cues
│   │   ├── voice.test.ts             # Unit tests for voice pipeline
│   │   ├── actions.ts                # Action dispatcher (click, navigate, fill)
│   │   ├── actions.test.ts           # Unit tests for action execution
│   │   ├── storage.ts                # chrome.storage.local wrapper (session + profile)
│   │   ├── storage.test.ts           # Unit tests for storage
│   │   ├── prompts.ts                # System prompts and prompt builders
│   │   └── prompts.test.ts           # Unit tests for prompt construction
│   │
│   └── types/                        # TypeScript type definitions
│       ├── messages.ts               # Message types (content ↔ service worker)
│       ├── page.ts                   # PageStructure, PageElement, Action types
│       └── profile.ts                # UserProfile, SavedAddress types
│
├── public/                           # Static assets (copied as-is to build output)
│   ├── _locales/
│   │   └── en/
│   │       └── messages.json         # Extension name and description
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
│
├── scripts/                          # Development and build scripts
│   └── verify-models.mjs             # Pre-build: verify Gemma 4 model ID on Fireworks
│
├── doc/                              # Project documentation (25 docs)
│   ├── DOC-PRODUCT-VISION.md         # What we're building and why
│   ├── DOC-AGENT-BEHAVIOR.md         # Agent behavior and guardrails
│   ├── DOC-ARCHITECTURE.md           # System design and MV3 components
│   ├── DOC-MVP-SPEC.md               # Exact MVP scope
│   ├── DOC-BUILD-PHASES.md           # 9 build phases (A–I), ~25 hours
│   ├── DOC-STACK-DECISIONS.md        # Technology choices and justifications
│   ├── DOC-MODEL-ADR.md              # Gemma 4 model selection decision
│   ├── DOC-CALL-STRATEGY.md          # When AI is called and what it returns
│   ├── DOC-PAGE-MODEL.md             # DOM walk extraction logic
│   ├── DOC-VOICE.md                  # Voice pipeline (STT/TTS)
│   ├── DOC-VOICE-STANDARDS.md        # Voice interaction standards
│   ├── DOC-FIREWORKS-INTEGRATION.md  # Fireworks AI integration details
│   ├── DOC-AMD-STACK-RESEARCH.md     # AMD GPU stack research
│   ├── DOC-AMD-DEPLOY.md             # AMD deployment notes
│   ├── DOC-CONTEXT-MEMORY.md         # Session memory and user profile
│   ├── DOC-USE-CASES.md              # 3 core demo journeys + 2 stretch
│   ├── DOC-DEMO-PLAN.md              # Live demo script
│   ├── DOC-FUTURE-UPDATES.md         # Post-hackathon roadmap
│   ├── DOC-PRIOR-ART.md              # Existing browser agent research
│   ├── DOC-HACKATHON-INFO.md         # Hackathon rules and prizes
│   ├── DOC-DEV-PREREQUISITES.md      # Dev setup checklist
│   ├── DOC-DEV-SPLIT.md              # Korede vs Vivek ownership split
│   ├── DOC-DEV-STEPS.md              # Step-by-step dev guide
│   └── DOC-SUBMISSION-CHECKLIST.md   # Final submission checklist
│
├── wxt.config.ts                     # WXT configuration (permissions: ['activeTab'], default_locale: 'en')
├── package.json                      # Dependencies and scripts
├── pnpm-lock.yaml                    # Lockfile
├── tsconfig.json                     # TypeScript configuration
├── vitest.config.ts                  # Vitest test runner configuration
├── .env                              # Environment variables (API keys — gitignored)
├── .gitignore                        # Git ignore rules
├── Dockerfile                        # Multi-stage: builds extension, outputs unpacked dir (loaded via chrome://extensions)
├── AGENTS.md                         # Agent workspace instructions
└── README.md                         # This file
```

NO EMPTY FOLDERS OF FILES, CREATED ON BASED ON NEED.

---

## Architecture at a glance

```
User (blind/low-vision)
    │
    │  Alt+D → speak command → hear response
    ▼
Content Script (src/entrypoints/content.ts)
    │  DOM walk → extract page structure
    │  Web Speech API → listen + speak
    │  Execute actions (click, fill, navigate)
    │
    │  chrome.runtime.sendMessage()
    ▼
Service Worker (src/entrypoints/background.ts)
    │  Build prompt (system + context + command)
    │  Call Fireworks AI API (MiniMax M3 dev / Gemma 4 31B IT prod)
    │  Manage session (chrome.storage.local)
    │
    │  fetch() — HTTPS
    ▼
Fireworks AI API (AMD Instinct MI300X GPUs)
```

---

## Key files by ownership

**Korede owns** (content script side):
- `src/entrypoints/content.ts` — message sending, response handling, action execution
- `src/lib/dom-walk.ts` — page structure extraction
- `src/lib/voice.ts` — STT, TTS, audio cues, push-to-talk
- `src/lib/actions.ts` — click, navigate, fill, confirm flows
- `src/lib/dom-walk.test.ts`, `src/lib/voice.test.ts`, `src/lib/actions.test.ts`

**Vivek owns** (service worker side):
- `src/entrypoints/background.ts` — message routing, prompt building, API calls
- `src/lib/fireworks.ts` — Fireworks API client, retry, JSON parsing
- `src/lib/storage.ts` — chrome.storage.local wrapper, session state
- `src/lib/prompts.ts` — system prompts, prompt builders
- `src/lib/fireworks.test.ts`, `src/lib/storage.test.ts`, `src/lib/prompts.test.ts`

**Shared** (types and config):
- `src/types/` — message types, page model, profile types
- `wxt.config.ts`, `tsconfig.json`, `vitest.config.ts`

---

## Build phases

| Phase | Name | Hours | Owner | Status |
|-------|------|-------|-------|--------|
| A | Project scaffold | 1 | Korede | In progress (Termux) |
| B | DOM walk engine | 3 | Korede | Not started |
| C | Fireworks API client | 2 | Vivek | Not started |
| D | Voice pipeline | 3 | Korede | Not started |
| E | Command integration + VLM | 5 | Both | Not started |
| F | Actions & form filling | 3 | Korede | Not started |
| G | Context & profile | 2 | Vivek | Not started |
| H | Demo polish & testing | 4 | Both | Not started |
| I | Containerization & repo | 2 | Both | Not started |

See `doc/DOC-BUILD-PHASES.md` for detailed deliverables and Definition of Done per phase.

---

## Development

> **Platform note:** This repo is currently developed on Termux (Android aarch64).
> Termux cannot load a Chrome extension, so the Termux bar is:
> `pnpm install` `pnpm typecheck` `pnpm test` `pnpm build` all exit 0.
> Manual QA (load unpacked + test in Chrome) happens on a PC — see `doc/PC-QA-TEST.md`.

```bash
# Install dependencies
pnpm install

# Type-check all TypeScript
pnpm typecheck

# Run unit tests
pnpm test

# Build for production (outputs to .output/)
pnpm build

# Development mode with hot reload (REQUIRES Chrome on PC — NOT available on Termux)
pnpm dev

# Set the Fireworks API key
# 1. Open chrome://extensions
# 2. Click 

---

## Tech stack

| Layer | Choice | Why |
|-------|--------|-----|
| Platform | Chrome Extension (MV3) | Required for Chrome Web Store; modern API surface |
| Permissions | `activeTab` only | Content script auto-injected on page load for auto-summary |
| Language | TypeScript 5.x | Type safety for messaging, API calls, DOM manipulation |
| Build | WXT (Vite for extensions) | Purpose-built for browser extensions; auto manifest, typed APIs |
| AI | Fireworks AI → MiniMax M3 (dev) / Gemma 4 31B IT (prod) | Multimodal, AMD Instinct MI300X GPUs, Gemma prize eligible |
| Voice | Web Speech API (STT + TTS) | Free, browser-native, zero external dependencies |
| Testing | Vitest | Fast, ESM-native, works with WXT |
| UI | Options page (React/TS optional) | `options.ts` entry point — user enters Fireworks API key, saved to `chrome.storage.local` |

---

## Privacy

- **`activeTab` only** — no `tabs`, no `scripting`, no `host_permissions`, no cross-tab access
- **Content script auto-injected** — required for auto-summary on page load (core accessibility feature for blind users)
- **DOM walk only** — content script has no network access, all API calls routed through service worker
- **No cloud storage** — all data stays in your browser
- **API key is yours** — stored locally, sent only to Fireworks API
- **Never invents content** — if Diamond can't read it, it says so
- **Profile PII never reaches LLM** — only labels ("Home", "Office") are sent

---

## License

MIT
