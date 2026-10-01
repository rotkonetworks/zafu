#!/usr/bin/env bash
# Speculos (Ledger emulator) running the Ledger Zcash app, for the shielded
# Ledger e2e suite (src/ledger/zcash-app/speculos.e2e.test.ts).
#
#   ledger-speculos.sh build            clone + build the Zcash app ELF (Nano S+)
#   ledger-speculos.sh start [ELF]      start Speculos on 127.0.0.1, print SPECULOS_URL
#   ledger-speculos.sh test  [ELF]      start, run the e2e suite, stop
#   ledger-speculos.sh stop             remove the container
#   ledger-speculos.sh versions         print what would be / was used
#
# App: LedgerHQ/app-zcash 3.9.4 (Cargo.toml `version = "3.9.4"`, tag
# stax_1.10.1_3.9.4_sdk_v26.6.3), commit 1a0f6495458ecb77abf97c8cff25b0a1a344daaa
# - the same commit vizor-wallet's docs/ledger/speculos.md pins. Ledger does not
# publish app ELFs, so it is built from source with Ledger's official builder
# image (`cargo ledger build nanosplus`); the ELF lands at
# $LEDGER_SPECULOS_WORK/app-zcash/target/nanosplus/release/zcash.
#
# Images (vizor pins digests in a script not included in our reference copy, so
# these default to `latest` and `versions` prints the digests actually used;
# pin with the env overrides for a reproducible run):
#   LEDGER_BUILDER_IMAGE   ghcr.io/ledgerhq/ledger-app-builder/ledger-app-dev-tools:latest
#   LEDGER_SPECULOS_IMAGE  ghcr.io/ledgerhq/speculos:latest
#
# Other env:
#   LEDGER_ZCASH_ELF       prebuilt ELF (skips the build lookup)
#   LEDGER_SPECULOS_WORK   scratch dir for the checkout (default: $XDG_CACHE_HOME/zafu-ledger-speculos)
#   LEDGER_SPECULOS_PORT   API port on 127.0.0.1 (default 5000)
#   LEDGER_SPECULOS_SEED   custom BIP39 seed; default is Speculos's built-in test
#                          seed, which the suite cross-checks against software
#                          key derivation. NEVER a real seed.
#   DOCKER                 container CLI (default: docker; podman works)
#
# When Docker or the ELF is missing, `start`/`test` print why and exit 0 with
# "skipping", so CI without an emulator stays green without pretending a device
# answered (the suite itself skips unless SPECULOS_URL is set).

set -euo pipefail

APP_REPO="https://github.com/LedgerHQ/app-zcash.git"
APP_COMMIT="1a0f6495458ecb77abf97c8cff25b0a1a344daaa"
APP_VERSION="3.9.4"
BUILDER_IMAGE="${LEDGER_BUILDER_IMAGE:-ghcr.io/ledgerhq/ledger-app-builder/ledger-app-dev-tools:latest}"
SPECULOS_IMAGE="${LEDGER_SPECULOS_IMAGE:-ghcr.io/ledgerhq/speculos:latest}"
WORK="${LEDGER_SPECULOS_WORK:-${XDG_CACHE_HOME:-$HOME/.cache}/zafu-ledger-speculos}"
PORT="${LEDGER_SPECULOS_PORT:-5000}"
NAME="zafu-ledger-speculos-${PORT}"
DOCKER="${DOCKER:-docker}"
EXT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_ELF="$WORK/app-zcash/target/nanosplus/release/zcash"

log() { printf '[ledger-speculos] %s\n' "$*" >&2; }
skip() {
  log "skipping: $*"
  exit 0
}

have_docker() { command -v "$DOCKER" >/dev/null 2>&1 && "$DOCKER" info >/dev/null 2>&1; }

elf_path() { printf '%s' "${1:-${LEDGER_ZCASH_ELF:-$DEFAULT_ELF}}"; }

image_digest() {
  "$DOCKER" image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}' "$1" 2>/dev/null ||
    echo "(not pulled)"
}

cmd_versions() {
  echo "app: LedgerHQ/app-zcash $APP_VERSION @ $APP_COMMIT"
  echo "builder: $(image_digest "$BUILDER_IMAGE")"
  echo "speculos: $(image_digest "$SPECULOS_IMAGE")"
  local elf
  elf="$(elf_path "${1:-}")"
  if [[ -f "$elf" ]]; then
    echo "elf: $elf sha256=$(sha256sum "$elf" | cut -d' ' -f1)"
  else
    echo "elf: (not built) $elf"
  fi
}

cmd_build() {
  have_docker || { log "docker ($DOCKER) is not available"; exit 1; }
  mkdir -p "$WORK"
  if [[ ! -d "$WORK/app-zcash/.git" ]]; then
    git clone --quiet "$APP_REPO" "$WORK/app-zcash"
  fi
  git -C "$WORK/app-zcash" fetch --quiet origin "$APP_COMMIT" 2>/dev/null || true
  git -C "$WORK/app-zcash" checkout --quiet "$APP_COMMIT"
  grep -q "^version = \"$APP_VERSION\"" "$WORK/app-zcash/Cargo.toml" ||
    { log "checkout is not app version $APP_VERSION"; exit 1; }
  "$DOCKER" pull --quiet "$BUILDER_IMAGE" >/dev/null
  # :Z relabels for SELinux hosts; harmless elsewhere
  "$DOCKER" run --rm -v "$WORK/app-zcash:/app:Z" -w /app "$BUILDER_IMAGE" \
    bash -lc 'cargo ledger build nanosplus'
  [[ -f "$DEFAULT_ELF" ]] || { log "build finished but $DEFAULT_ELF is missing"; exit 1; }
  cmd_versions
}

wait_ready() {
  local url="http://127.0.0.1:$PORT"
  for _ in $(seq 1 60); do
    if curl -sf -X POST "$url/apdu" -H 'Content-Type: application/json' \
      -d '{"data":"b001000000"}' 2>/dev/null | grep -q '9000"'; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

cmd_start() {
  have_docker || skip "docker ($DOCKER) is not available"
  local elf
  elf="$(elf_path "${1:-}")"
  [[ -f "$elf" ]] || skip "no Zcash app ELF at $elf - run '$0 build' or set LEDGER_ZCASH_ELF"
  "$DOCKER" rm -f "$NAME" >/dev/null 2>&1 || true
  local seed_args=()
  if [[ -n "${LEDGER_SPECULOS_SEED:-}" ]]; then
    seed_args=(--seed "$LEDGER_SPECULOS_SEED")
  fi
  # loopback only: the emulator holds a seed and its API has no auth
  "$DOCKER" run -d --rm --name "$NAME" \
    -p "127.0.0.1:$PORT:5000" \
    -v "$(dirname "$elf"):/speculos/apps:Z,ro" \
    "$SPECULOS_IMAGE" \
    --model nanosp --display headless --api-port 5000 --apdu-port 40000 \
    "${seed_args[@]}" "/speculos/apps/$(basename "$elf")" >/dev/null
  if ! wait_ready; then
    "$DOCKER" logs "$NAME" >&2 || true
    cmd_stop
    log "Speculos did not come up"
    exit 1
  fi
  echo "SPECULOS_URL=http://127.0.0.1:$PORT"
}

cmd_stop() {
  "$DOCKER" rm -f "$NAME" >/dev/null 2>&1 || true
}

cmd_test() {
  have_docker || skip "docker ($DOCKER) is not available"
  local elf
  elf="$(elf_path "${1:-}")"
  [[ -f "$elf" ]] || skip "no Zcash app ELF at $elf - run '$0 build' or set LEDGER_ZCASH_ELF"
  cmd_start "$elf" >/dev/null
  trap cmd_stop EXIT
  cmd_versions "$elf" >&2
  local seed_env=()
  if [[ -n "${LEDGER_SPECULOS_SEED:-}" ]]; then
    seed_env=(SPECULOS_SEED="$LEDGER_SPECULOS_SEED")
  fi
  (cd "$EXT_DIR" && env SPECULOS_URL="http://127.0.0.1:$PORT" "${seed_env[@]}" \
    pnpm exec vitest run src/ledger/zcash-app/speculos.e2e.test.ts)
}

case "${1:-}" in
  build) cmd_build ;;
  start) cmd_start "${2:-}" ;;
  stop) cmd_stop ;;
  test) cmd_test "${2:-}" ;;
  versions) cmd_versions "${2:-}" ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
