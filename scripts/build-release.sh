#!/bin/bash
# Build script for Prax extension release with local penumbra-web
# Usage: ./scripts/build-release.sh [--beta|--prod|--all] [--skip-wasm] [--sign]
#
# Creates reproducible, verifiable builds with:
# - Git commit hashes embedded in manifest
# - Build manifest with all dependency versions
# - SHA256 checksums for verification

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRAX_DIR="$(dirname "$SCRIPT_DIR")"
PENUMBRA_WEB_DIR="$PRAX_DIR/../penumbra-web"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default options
BUILD_TARGET="all"
SKIP_WASM=false
SIGN_EXTENSION=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --beta)
      BUILD_TARGET="beta"
      shift
      ;;
    --prod)
      BUILD_TARGET="prod"
      shift
      ;;
    --all)
      BUILD_TARGET="all"
      shift
      ;;
    --skip-wasm)
      SKIP_WASM=true
      shift
      ;;
    --sign)
      SIGN_EXTENSION=true
      shift
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      exit 1
      ;;
  esac
done

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Prax Extension Release Build${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "Build target: ${GREEN}$BUILD_TARGET${NC}"
echo -e "Skip WASM:    ${GREEN}$SKIP_WASM${NC}"
echo -e "Sign:         ${GREEN}$SIGN_EXTENSION${NC}"
echo ""

# Check penumbra-web directory exists
if [ ! -d "$PENUMBRA_WEB_DIR" ]; then
  echo -e "${RED}Error: penumbra-web directory not found at $PENUMBRA_WEB_DIR${NC}"
  exit 1
fi

# Step 1: Compile WASM in penumbra-web
if [ "$SKIP_WASM" = false ]; then
  echo -e "${YELLOW}Step 1: Compiling WASM in penumbra-web...${NC}"
  cd "$PENUMBRA_WEB_DIR/packages/wasm"

  echo -e "  ${BLUE}Compiling regular WASM...${NC}"
  pnpm compile

  echo -e "  ${BLUE}Compiling parallel WASM with rayon...${NC}"
  pnpm compile:parallel

  echo -e "${GREEN}✓ WASM compilation complete${NC}"
  echo ""
else
  echo -e "${YELLOW}Step 1: Skipping WASM compilation (--skip-wasm)${NC}"
  echo ""
fi

# Step 2: Build penumbra-web packages
echo -e "${YELLOW}Step 2: Building penumbra-web packages...${NC}"
cd "$PENUMBRA_WEB_DIR"
pnpm build
echo -e "${GREEN}✓ penumbra-web packages built${NC}"
echo ""

# Step 3: Install/sync dependencies in prax
echo -e "${YELLOW}Step 3: Syncing prax dependencies...${NC}"
cd "$PRAX_DIR"
pnpm install --ignore-scripts || true  # Ignore syncpack warnings for file: links

# pnpm file: links don't always sync generated directories like wasm-parallel
# Find all @penumbra-zone/wasm pnpm stores and sync wasm-parallel to them
echo -e "  ${BLUE}Syncing wasm-parallel to pnpm stores...${NC}"
for wasm_store in $(find "$PRAX_DIR/node_modules/.pnpm" -path "*@penumbra-zone+wasm*" -name "wasm" -type d 2>/dev/null); do
  wasm_pkg_dir=$(dirname "$wasm_store")
  if [ ! -d "$wasm_pkg_dir/wasm-parallel" ]; then
    echo -e "  Copying wasm-parallel to $wasm_pkg_dir"
    cp -r "$PENUMBRA_WEB_DIR/packages/wasm/wasm-parallel" "$wasm_pkg_dir/"
  fi
done
echo -e "${GREEN}✓ Dependencies synced${NC}"
echo ""

# Step 4: Build prax extension
echo -e "${YELLOW}Step 4: Building prax extension...${NC}"
cd "$PRAX_DIR/apps/extension"

if [ "$BUILD_TARGET" = "beta" ] || [ "$BUILD_TARGET" = "all" ]; then
  echo -e "  ${BLUE}Building beta...${NC}"
  pnpm bundle:beta
  echo -e "${GREEN}  ✓ Beta build complete${NC}"
fi

if [ "$BUILD_TARGET" = "prod" ] || [ "$BUILD_TARGET" = "all" ]; then
  echo -e "  ${BLUE}Building production...${NC}"
  pnpm bundle:prod
  echo -e "${GREEN}  ✓ Production build complete${NC}"
fi
echo ""

# Step 5: Create zip files
echo -e "${YELLOW}Step 5: Creating zip files...${NC}"
cd "$PRAX_DIR/apps/extension"

VERSION=$(node -p "require('./package.json').version")
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

if [ "$BUILD_TARGET" = "beta" ] || [ "$BUILD_TARGET" = "all" ]; then
  ZIP_NAME="prax-v${VERSION}-beta-${TIMESTAMP}.zip"
  rm -f "$ZIP_NAME"
  cd beta-dist && zip -r "../$ZIP_NAME" . && cd ..
  echo -e "${GREEN}  ✓ Created $ZIP_NAME${NC}"
fi

if [ "$BUILD_TARGET" = "prod" ] || [ "$BUILD_TARGET" = "all" ]; then
  ZIP_NAME="prax-v${VERSION}-${TIMESTAMP}.zip"
  rm -f "$ZIP_NAME"
  cd dist && zip -r "../$ZIP_NAME" . && cd ..
  echo -e "${GREEN}  ✓ Created $ZIP_NAME${NC}"
fi
echo ""

# Step 6: Sign extension (optional)
if [ "$SIGN_EXTENSION" = true ]; then
  echo -e "${YELLOW}Step 6: Signing extension...${NC}"

  # Check for required environment variables
  if [ -z "$CHROME_EXTENSION_ID" ]; then
    echo -e "${RED}Error: CHROME_EXTENSION_ID not set${NC}"
    echo "Set it with: export CHROME_EXTENSION_ID=your-extension-id"
    exit 1
  fi

  if [ -z "$CHROME_CLIENT_ID" ] || [ -z "$CHROME_CLIENT_SECRET" ] || [ -z "$CHROME_REFRESH_TOKEN" ]; then
    echo -e "${RED}Error: Chrome Web Store API credentials not set${NC}"
    echo "Required environment variables:"
    echo "  CHROME_CLIENT_ID"
    echo "  CHROME_CLIENT_SECRET"
    echo "  CHROME_REFRESH_TOKEN"
    echo ""
    echo "See: https://developer.chrome.com/docs/webstore/using_webstore_api/"
    exit 1
  fi

  # Use chrome-webstore-upload-cli if available
  if command -v chrome-webstore-upload &> /dev/null; then
    ZIP_FILE=$(ls -t prax-v*.zip 2>/dev/null | head -1)
    if [ -n "$ZIP_FILE" ]; then
      echo -e "  ${BLUE}Uploading $ZIP_FILE to Chrome Web Store...${NC}"
      chrome-webstore-upload upload \
        --source "$ZIP_FILE" \
        --extension-id "$CHROME_EXTENSION_ID" \
        --client-id "$CHROME_CLIENT_ID" \
        --client-secret "$CHROME_CLIENT_SECRET" \
        --refresh-token "$CHROME_REFRESH_TOKEN"
      echo -e "${GREEN}  ✓ Extension uploaded${NC}"
    fi
  else
    echo -e "${YELLOW}  chrome-webstore-upload-cli not installed${NC}"
    echo -e "  Install with: npm install -g chrome-webstore-upload-cli"
    echo -e "  Or manually upload the zip to Chrome Web Store Developer Dashboard"
  fi
  echo ""
fi

# Step 7: Generate build manifest and checksums for verification
echo -e "${YELLOW}Step 7: Generating build manifest and checksums...${NC}"
cd "$PRAX_DIR/apps/extension"

# Get git info
PRAX_COMMIT=$(cd "$PRAX_DIR" && git rev-parse HEAD)
PRAX_BRANCH=$(cd "$PRAX_DIR" && git rev-parse --abbrev-ref HEAD)
PRAX_DIRTY=$(cd "$PRAX_DIR" && git diff --quiet && echo "clean" || echo "dirty")

PENUMBRA_COMMIT=$(cd "$PENUMBRA_WEB_DIR" && git rev-parse HEAD)
PENUMBRA_BRANCH=$(cd "$PENUMBRA_WEB_DIR" && git rev-parse --abbrev-ref HEAD)
PENUMBRA_DIRTY=$(cd "$PENUMBRA_WEB_DIR" && git diff --quiet && echo "clean" || echo "dirty")

BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Create build manifest
MANIFEST_FILE="build-manifest-${TIMESTAMP}.json"
cat > "$MANIFEST_FILE" << EOF
{
  "version": "$VERSION",
  "build_time": "$BUILD_TIME",
  "build_target": "$BUILD_TARGET",
  "prax": {
    "commit": "$PRAX_COMMIT",
    "branch": "$PRAX_BRANCH",
    "status": "$PRAX_DIRTY",
    "repo": "https://github.com/rotkonetworks/prax"
  },
  "penumbra_web": {
    "commit": "$PENUMBRA_COMMIT",
    "branch": "$PENUMBRA_BRANCH",
    "status": "$PENUMBRA_DIRTY",
    "repo": "https://github.com/penumbra-zone/web"
  },
  "rust_toolchain": "$(rustc --version 2>/dev/null || echo 'unknown')",
  "wasm_bindgen": "$(wasm-bindgen --version 2>/dev/null || echo 'unknown')",
  "node_version": "$(node --version)",
  "pnpm_version": "$(pnpm --version)",
  "checksums": {}
}
EOF

# Generate checksums for all zip files and update manifest
echo -e "  ${BLUE}Generating SHA256 checksums...${NC}"
CHECKSUMS_FILE="checksums-${TIMESTAMP}.sha256"
> "$CHECKSUMS_FILE"

for zip in prax-v*.zip; do
  if [ -f "$zip" ]; then
    HASH=$(sha256sum "$zip" | cut -d' ' -f1)
    echo "$HASH  $zip" >> "$CHECKSUMS_FILE"
    echo -e "  ${GREEN}$zip${NC}: $HASH"

    # Update manifest with checksum
    TMP=$(mktemp)
    jq --arg file "$zip" --arg hash "$HASH" '.checksums[$file] = $hash' "$MANIFEST_FILE" > "$TMP" && mv "$TMP" "$MANIFEST_FILE"
  fi
done

# Also checksum the WASM files for verification
echo "" >> "$CHECKSUMS_FILE"
echo "# WASM binaries" >> "$CHECKSUMS_FILE"
if [ -f "$PENUMBRA_WEB_DIR/packages/wasm/wasm/index_bg.wasm" ]; then
  WASM_HASH=$(sha256sum "$PENUMBRA_WEB_DIR/packages/wasm/wasm/index_bg.wasm" | cut -d' ' -f1)
  echo "$WASM_HASH  wasm/index_bg.wasm" >> "$CHECKSUMS_FILE"
fi
if [ -f "$PENUMBRA_WEB_DIR/packages/wasm/wasm-parallel/index_bg.wasm" ]; then
  WASM_PARALLEL_HASH=$(sha256sum "$PENUMBRA_WEB_DIR/packages/wasm/wasm-parallel/index_bg.wasm" | cut -d' ' -f1)
  echo "$WASM_PARALLEL_HASH  wasm-parallel/index_bg.wasm" >> "$CHECKSUMS_FILE"
fi

echo -e "${GREEN}✓ Build manifest and checksums generated${NC}"
echo ""

# Summary
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}  Build Complete!${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "${BLUE}Git commits:${NC}"
echo -e "  prax:         ${GREEN}$PRAX_COMMIT${NC} ($PRAX_BRANCH, $PRAX_DIRTY)"
echo -e "  penumbra-web: ${GREEN}$PENUMBRA_COMMIT${NC} ($PENUMBRA_BRANCH, $PENUMBRA_DIRTY)"
echo ""
echo -e "${BLUE}Output files in $PRAX_DIR/apps/extension/:${NC}"
ls -la "$PRAX_DIR/apps/extension/"prax-v*.zip 2>/dev/null || echo "  (no zip files)"
echo ""
ls -la "$PRAX_DIR/apps/extension/"build-manifest*.json 2>/dev/null || echo "  (no manifest)"
echo ""
ls -la "$PRAX_DIR/apps/extension/"checksums*.sha256 2>/dev/null || echo "  (no checksums)"
echo ""
echo -e "${YELLOW}To verify a build:${NC}"
echo "  sha256sum -c checksums-${TIMESTAMP}.sha256"
echo ""
echo -e "${YELLOW}To reproduce this build:${NC}"
echo "  cd prax && git checkout $PRAX_COMMIT"
echo "  cd penumbra-web && git checkout $PENUMBRA_COMMIT"
echo "  ./scripts/build-release.sh --$BUILD_TARGET"
echo ""
