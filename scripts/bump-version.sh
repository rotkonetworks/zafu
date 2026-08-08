#!/usr/bin/env bash
# bump-version.sh — bump the zafu app version in EVERY place at once.
#
# Usage:
#   ./scripts/bump-version.sh 25.3.0
#   ./scripts/bump-version.sh 26.0.0
#
# The zafu *app* version is the Chrome extension's release version. It is
# mirrored in exactly three source files (must always stay in lockstep):
#   1. apps/extension/package.json          — the npm "version" field
#   2. apps/extension/public/manifest.json  — Chrome manifest "version"
#   3. apps/extension/public/beta-manifest.json — beta manifest "version"
#
# The on-screen About page (*settings-about.tsx*) reads
# chrome.runtime.getManifest().version automatically — do NOT hardcode it — so
# it follows manifest.json for free (no file to touch here).
#
# It then rebuilds so dist/ + beta-dist/ carry the new version in every bundle.
# Requires the new version to be a valid semver.
set -euo pipefail

NEW_VERSION="${1:-}"
if [[ -z "$NEW_VERSION" ]]; then
  echo "usage: $0 <new-version>   e.g. $0 25.3.0" >&2
  exit 2
fi
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: '$NEW_VERSION' is not a valid three-part semver (e.g. 25.3.0)" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FILES=(
  "apps/extension/package.json"
  "apps/extension/public/manifest.json"
  "apps/extension/public/beta-manifest.json"
)

echo "zafu: bumping app version -> $NEW_VERSION"
for f in "${FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "  ERROR: missing $f" >&2
    exit 1
  fi
  # sed in-place: replace the "version": "X.Y.Z" value.
  sed -i -E "s/^(\s*\"version\"\s*:\s*\")[0-9]+\.[0-9]+\.[0-9]+(\".*,?)$/\1${NEW_VERSION}\2/" "$f"
  echo "  updated $f"
done

echo
echo "Verifying all three now report $NEW_VERSION:"
grep -H '"version"' "${FILES[@]}"

echo
echo "Rebuilding (dist/ + beta-dist/) with the new version..."
# gu: build produces both dist and beta-dist with the manifest version baked in.
if command -v pnpm >/dev/null 2>&1; then
  pnpm build
else
  npm run build
fi

echo
echo "Done. Confirm on the About page or in dist/:"
echo "  grep -o '\"version\": \"$NEW_VERSION\"' apps/extension/dist/manifest.json"
