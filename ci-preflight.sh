#!/usr/bin/env bash
#
# CI preflight for zafu - runs exactly what .github/workflows/turbo-ci.yml runs,
# so a red-CI email never beats you to it. Run from anywhere:
#
#     ./ci-preflight.sh
#
# Mirrors the three CI jobs: lint:strict (tsc --noEmit + eslint --max-warnings 0),
# build (bundle:prod + bundle:beta), and test (vitest run). Uses `--force` so
# turbo's cache can't hand back a stale green (a cached pass has masked real
# breakage here before). Runs every check even if an earlier one fails, then
# prints a summary and exits non-zero if anything failed.

set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

results=()
step() {
  local name="$1"; shift
  printf '\n\033[1m═══ %s ═══\033[0m\n$ %s\n' "$name" "$*"
  if "$@"; then results+=("PASS  $name"); else results+=("FAIL  $name"); fi
}

# CI installs with --frozen-lockfile; matching it here catches a lockfile that
# drifted from package.json (a common cause of green-local / red-CI).
step "install (frozen-lockfile)" pnpm install --frozen-lockfile

# --force bypasses the turbo cache so these actually re-run.
step "lint:strict"               pnpm turbo lint:strict --force
step "build"                     pnpm turbo build --force
step "test"                      pnpm turbo test --force

printf '\n\033[1m════════ SUMMARY ════════\033[0m\n'
rc=0
for r in "${results[@]}"; do
  if [[ $r == PASS* ]]; then printf '  \033[32m%s\033[0m\n' "$r"
  else printf '  \033[31m%s\033[0m\n' "$r"; rc=1; fi
done
if [[ $rc -eq 0 ]]; then
  printf '\n\033[32mAll CI checks would PASS - safe to push.\033[0m\n'
else
  printf '\n\033[31mSome checks FAILED - fix before pushing (CI would email you).\033[0m\n'
fi
exit $rc
