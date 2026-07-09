# Diamond Access AI — Submission Dockerfile
#
# AMD Cloud submission support (lablab.ai ACT II Hackathon requirement).
# Builds the Chrome extension via WXT and serves the unpacked
# output as a static download via nginx. Judges can grab the
# extension by curling http://<instance-ip>/manifest.json and
# loading it unpacked in Chrome.
#
# Build hygiene:
# The .dockerignore excludes the developer's .env file. The
# production build therefore has NO `VITE_FW_KEY` injected,
# and the `import.meta.env.DEV` guard in `background.ts` ensures
# the seed function is tree-shaken from the production bundle.
# `scripts/verify-no-secrets.sh` is the last gate.

# ── Stage 1: Build the Chrome extension ──────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Install pnpm globally
RUN npm install -g pnpm

# Copy lockfile + manifest first for deterministic dependency install
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy the rest of the source. .dockerignore excludes .env, .git, etc.
COPY . .

# Production build. The seedApiKeyIfMissing() function in background.ts
# has an import.meta.env.DEV guard tree-shaken into 'false' at this
# stage, so VITE_FW_KEY is never read into the bundle.
RUN pnpm build

# Defense-in-depth scan: NO fw_* keys must appear in the output.
RUN ! grep -RE 'fw_[A-Za-z0-9]{20,}' .output/ \
    || (echo "ERROR: Fireworks API key leaked into build!" >&2 && exit 1)

# ── Stage 2: Serve unpacked extension ───────────────────────────────
FROM nginx:alpine

# Replace default nginx page with the unpacked extension.
COPY --from=builder /app/.output/chrome-mv3/ /usr/share/nginx/html/

EXPOSE 80

# A small landing page describing what's served (optional niceness;
# not required for judges — they just need the static files).
RUN echo 'Diamond Access AI — Unpacked Chrome extension. <br>Load <code>chrome://extensions</code> → Developer mode → Load unpacked → select this folder.' \
    > /usr/share/nginx/html/index.html

CMD ["nginx", "-g", "daemon off;"]
