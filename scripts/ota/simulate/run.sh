#!/usr/bin/env bash
# Zafu OTA PC simulation: wallet -> QR PNGs -> "camera" decode -> reassemble ->
# verify -> device result -> verify. No phone, no emulator needed.
# Usage: scripts/ota/simulate/run.sh [moduleSizeBytes] [outDir]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TSX="$ROOT/node_modules/.bin/tsx"
SIM="$ROOT/scripts/ota/simulate"
OUT="${2:-/tmp/zafu-ota-sim}"
SIZE="${1:-262144}"
rm -rf "$OUT"; mkdir -p "$OUT"
echo "== STEP 1: wallet produces signed module + QR frames =="
"$TSX" "$SIM/emit.ts" "$OUT" "$SIZE" | grep '\[wallet\]' || true
echo "== STEP 2: 'camera' decodes QR PNGs =="
python3 "$SIM/decode_frames.py" "$OUT"
echo "== STEP 3: reassemble + verify + device result =="
"$TSX" "$SIM/verify.ts" "$OUT" | grep '\[verify\]' || true
echo "== done =="
