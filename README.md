# Diamond Access AI

A voice-first Chrome extension that makes any website fully accessible to blind and low-vision users. One keyboard shortcut → ask anything about the page → hear the answer.

**Built for AMD Developer Hackathon: ACT II** | July 6–11, 2026 | Unicorn Track

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

## Privacy

- **`activeTab` only** — no background scraping, no host permissions
- **No cloud storage** — all data stays in your browser
- **API key is yours** — stored locally, sent only to Fireworks API
- **Never invents content** — if Diamond can't read it, it says so

## Development

```bash
# Install dependencies
pnpm install

# Development mode (hot reload)
pnpm dev

# Build for production
pnpm build
```

## Project docs

All architecture decisions, research, and planning docs are in `doc/`:
- `DOC-PRODUCT-VISION.md` — What we're building and why
- `DOC-ARCHITECTURE.md` — System design and MV3 components
- `DOC-CALL-STRATEGY.md` — How the AI is called and what it returns
- `DOC-VOICE.md` — Voice pipeline (STT/TTS)
- `DOC-PAGE-MODEL.md` — DOM walk extraction logic
- `DOC-DEMO-PLAN.md` — Live demo script
- See all docs: `ls doc/DOC-*.md`

## Tech stack

| Layer | Choice |
|-------|--------|
| Platform | Chrome Extension (MV3) |
| AI | Fireworks AI → Gemma 4 26B A4B (AMD Instinct MI300X) |
| Voice | Web Speech API (STT + TTS) |
| Build | WXT (Vite for extensions) |

## License

MIT
