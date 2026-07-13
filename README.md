# Diamond Access AI

Voice-first browser accessibility assistant for blind and low-vision users.
A Chrome extension (MV3) that reads pages, answers questions, and performs actions — all by voice.

**Built for AMD Developer Hackathon: ACT II** | July 6–11, 2026 | Unicorn Track

---

## Features

- **Page summary on every load** — you always know where you are, what's on the page, and what you can do
- **Push-to-talk** — press Alt+D, speak naturally, hear Diamond respond
- **Voice commands** — summarize, list links, navigate, click buttons, fill forms
- **VLM fallback** — for image-heavy or canvas-only pages, Diamond describes what it sees
- **Conversation history** — Diamond remembers context across a session and tracks your active goal
- **Sensitive-field masking** — passwords, credit cards, and SSN are never spoken in full (last 4 digits only)
- **Confirmation flow** — irreversible actions (submit, delete, purchase) always ask before executing
- **Screen-reader coexistence** — designed to work alongside NVDA, JAWS, and VoiceOver

---

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/kore4lyf/diamond-access-ai
cd diamond-access-ai

# 2. Install dependencies
pnpm install

# 3. Build the extension
pnpm build
```

### Load in Chrome

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (toggle top-right)
3. Click **"Load unpacked"**
4. Select the `.output/chrome-mv3/` folder
5. Right-click the Diamond icon → **Options**
6. Enter your Fireworks AI API key and click **Save**

That's it. Navigate to any page, press **Alt+D**, and speak.

---

## Running with Docker

For judges, evaluators, or quick deployment, Diamond can be built and served via Docker with the API key embedded.

### Build the Docker Image

```bash
# Clone the repo
git clone https://github.com/kore4lyf/diamond-access-ai
cd diamond-access-ai

# Build with your Fireworks API key
docker build --build-arg VITE_FW_KEY=fw_YOUR_API_KEY_HERE -t diamond-access-ai .
```

Replace `fw_YOUR_API_KEY_HERE` with your actual Fireworks API key. Get one at [fireworks.ai](https://fireworks.ai).

**What this does:**
- Builds the Chrome extension using WXT
- Embeds your API key into the extension bundle (so judges don't need to configure it manually)
- Creates an nginx server that serves the unpacked extension files
- Image size: ~150MB

### Run the Container

```bash
docker run -d -p 80:80 --name diamond diamond-access-ai
```

**Flags explained:**
- `-d` — Run in detached mode (background)
- `-p 80:80` — Map container port 80 to host port 80
- `--name diamond` — Name the container "diamond"

### Verify the Server is Running

```bash
curl http://localhost/manifest.json
```

You should see the extension's manifest.json content.

### Load the Extension in Chrome

**Option 1: Extract files from the running container**

```bash
# Copy extension files from container to your machine
docker cp diamond:/usr/share/nginx/html ./diamond-extension
```

Then load in Chrome:
1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right)
3. Click **"Load unpacked"**
4. Select the `./diamond-extension` folder

**Option 2: Download from a remote server**

If the container is running on a remote server (e.g., `http://129.212.201.11`):

```bash
# Download the entire extension directory
wget -r -np -nH --cut-dirs=1 http://YOUR_SERVER_IP/ -P diamond-extension/
```

Then load the `diamond-extension` folder in Chrome (same steps as above).

### Using the Extension

The API key is already embedded — no manual configuration needed.

1. Navigate to any website (e.g., `bbc.com/news`)
2. Press **Alt+D**
3. Say: **"summarize this page"**
4. Diamond will read the page summary aloud

**Example commands:**
- `"list the headlines"` — Lists all links on the page
- `"go to the first article"` — Navigates to the first link
- `"find the cheapest option"` — Goal detection (on shopping sites)
- `"fill my contact info"` — Auto-fills forms (if profile is set in Options)

### Troubleshooting

**Extension not loading:**
- Make sure you selected the correct directory (contains `manifest.json`)

**API key not working:**
- Rebuild the Docker image with the correct key
- Check your API key at [fireworks.ai/api-keys](https://fireworks.ai/api-keys)

**No audio output:**
- Check browser permissions (site settings → sound)
- Ensure system audio is not muted

**Alt+D not working:**
- Some pages (chrome://, extension pages) block content scripts
- Use `Ctrl+Shift+D` instead, or click the Diamond icon manually

**Docker container not starting:**
```bash
# Check container logs
docker logs diamond

# Restart container
docker restart diamond

# Remove and recreate
docker stop diamond && docker rm diamond
docker run -d -p 80:80 --name diamond diamond-access-ai
```

### Stopping the Container

```bash
# Stop the container
docker stop diamond

# Remove the container
docker rm diamond

# Remove the image (optional)
docker rmi diamond-access-ai
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| **`Alt+D`** | **Primary** — push-to-talk. Captured by the content-script `keydown` listener with `e.preventDefault()` to block Chrome's omnibox focus shortcut. Works on any page where the extension is loaded. |
| `Ctrl+Shift+D` | **Fallback** — Chrome manifest binding. Use if Alt+D is intercepted by another shortcut. Set this at `chrome://extensions/shortcuts`. |
| `Alt+Shift+D` | **Fallback 2** — Chrome manifest binding. |

> **Why two paths?** Chrome strips `Alt+D` from the `chrome.commands` manifest binding because the browser reserves it for the omnibox focus shortcut. Diamond's content script captures `Alt+D` via a `keydown` listener (capture phase) and `preventDefault()`s the omnibox steal, restoring Alt+D as the primary UX shortcut. The manifest binding for `Ctrl+Shift+D` / `Alt+Shift+D` is a deliberate fallback for environments where the content-script listener doesn't fire (e.g., extension warning pages, browser settings pages).

### Voice shortcuts (spoken, not key-bound)

| Spoken phrase | Action |
|---------------|--------|
| Say *"clear context"* | Reset conversation history and active goal |
| Say *"where was I?"* | Recap what you were doing |
| Say *"confirm"* / *"yes"* | Confirm a pending action (submit, delete, purchase) |

---

## Architecture

Diamond uses a three-layer architecture:

```
User (voice in/out)
    │
    ▼
Content Script  ──DOM walk──▶ Page structure
(voice, actions)              Web Speech API (STT → TTS)
    │
    │ chrome.runtime.sendMessage()
    ▼
Service Worker  ──prompt builder──▶ conversation history + goal
(API calls,                       Fireworks AI (MiniMax M3 on AMD MI300X)
 session mgmt)
    │
    │ fetch()
    ▼
Fireworks AI API  ▶  LLM response  ▶  action JSON  ▶  execute in page
```

- **Content script** (`src/entrypoints/content.ts`): DOM walk, speech recognition, text-to-speech, action execution
- **Service worker** (`src/entrypoints/background.ts`): prompt construction, LLM calls, session management
- **AI API** (Fireworks → MiniMax M3): multimodal LLM running on AMD Instinct MI300X GPUs

See [`doc/DOC-ARCHITECTURE.md`](doc/DOC-ARCHITECTURE.md) for the full system design.

---

## Project structure

```
src/
├── entrypoints/
│   ├── background.ts    Service worker — LLM calls, session, message routing
│   ├── content.ts       Content script — DOM walk, voice, action execution
│   └── options.ts       Options page — API key configuration
├── lib/
│   ├── actions.ts       Action execution engine (click, navigate, fill, confirm)
│   ├── dom-walk.ts      Page structure extraction (DOM → tokens)
│   ├── errors.ts        Central error UX constants
│   ├── fireworks.ts     Fireworks AI API client
│   ├── page-snapshot.ts Page snapshot builder (structure + elements)
│   ├── prompts.ts       System prompts and prompt builders
│   ├── safety-net.ts    Irreversible-action keyword detector
│   ├── storage.ts       chrome.storage.local wrapper (session + profile)
│   └── voice.ts         STT (Web Speech API) + TTS + audio cues
└── types/               TypeScript type definitions
```

---

## Development

```bash
pnpm install       # Install dependencies
pnpm typecheck     # Type-check all TypeScript (strict mode)
pnpm test          # Run unit tests (Vitest)
pnpm build         # Production build → .output/chrome-mv3/
pnpm dev           # Dev mode with hot reload (requires Chrome on PC)
```

**Platform note:** This repo is primarily developed on Termux (Android aarch64), which cannot load a Chrome extension. The Termux bar is `typecheck` + `test` + `build` all passing. Manual QA (load unpacked + test in Chrome) happens on a PC — see [`doc/PC-QA-TEST.md`](doc/PC-QA-TEST.md).

---

## Privacy

- **`activeTab` only** — no `tabs`, no `scripting`, no `host_permissions`
- **DOM walk only** — content script reads the page DOM; all API calls go through the service worker
- **No cloud storage** — your data stays in your browser's local storage
- **API key is yours** — stored in `chrome.storage.local`, sent only to Fireworks AI
- **Never invents content** — if Diamond can't read the page, it says so
- **Profile PII never reaches the LLM** — only labels like "Home" or "email address" are sent in the prompt; actual values are resolved client-side

---

## Known Limitations

- **No wake word in MVP** — push-to-talk only (Alt+D). "Hey Diamond" wake word is a stretch goal.
- **No conversation persistence across browser restarts** — session is cleared on browser start. Profile data (addresses, links) persists.
- **VLM fallback is best-effort** — works well for common pages, not reliable for complex charts or data visualizations.
- **Screen-reader coexistence** — tested with common configurations but not guaranteed with all SR combinations and settings.
- **Keyword-based safety net** — the irreversible-action detector matches keywords like "submit" and "delete" in button text. An element labeled only with an icon (e.g., "✓") may not trigger confirmation. Demo pages should use text-labeled buttons.
- **English only** — STT and prompts are English-only in the MVP.

---

## License

MIT
