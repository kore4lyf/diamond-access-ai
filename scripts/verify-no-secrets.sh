#!/usr/bin/env bash
# Diamond Access AI — Pre-submission Secret Scan
#
# Defense-in-depth guard against accidentally committing Fireworks
# API keys into source or build artifacts. Phase I added this script
# as the final gate before `pnpm build` and `git push`.
#
# Usage:
#   ./scripts/verify-no-secrets.sh
#
# Exit codes:
#   0 — clean, no leaks
#   1 — leak detected (printed to stderr)
#
# Notes:
#   - Must run from repo root.
#   - Built on the assumption that valid Fireworks keys follow the
#     `fw_<20+ alphanumeric>` pattern. False positives extremely rare.

set -e

echo "── Diamond Access AI — Secret Scan ─────────────────────────────────"
echo ""

# Source files (committed + uncommitted)
echo "[1/3] Scanning src/ for Fireworks API keys…"
if grep -RE 'fw_[A-Za-z0-9]{20,}' src/ ; then
  echo ""
  echo "ERROR: Fireworks API key found in src/." >&2
  echo "Fix: remove the key reference, or rebuild with .env absent." >&2
  exit 1
fi
echo "  OK: src/ is clean."

# Build artifacts (the .output/ that judges receive)
echo "[2/3] Scanning .output/ for Fireworks API keys…"
if [ -d .output ]; then
  if grep -RE 'fw_[A-Za-z0-9]{20,}' .output/ 2>/dev/null ; then
    echo ""
    echo "ERROR: Fireworks API key found in .output/." >&2
    echo "Fix: remove .env before running 'pnpm build.' The seed function in" >&2
    echo "     background.ts is DEV-only and tree-shaken in production." >&2
    exit 1
  fi
fi
echo "  OK: .output/ is clean (or absent)."

# Git history (commits already pushed)
echo "[3/3] Scanning git history for Fireworks API keys…"
if git log --all -p 2>/dev/null | grep -E 'fw_[A-Za-z0-9]{20,}' > /dev/null ; then
  echo ""
  echo "ERROR: Fireworks API key found in git history." >&2
  echo "Fix: remove the commit (interactive rebase) and rotate the key." >&2
  exit 1
fi
echo "  OK: git history is clean."

echo ""
echo "── Result: PASS. No leaked Fireworks API keys. ────────────────────"
exit 0
