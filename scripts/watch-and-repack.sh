#!/bin/bash

# Check if `PENUMBRA_ZONE_WEB_PATH` is set and points to a valid directory
if [ -z "$PENUMBRA_ZONE_WEB_PATH" ] || [ ! -d "$PENUMBRA_ZONE_WEB_PATH" ]; then
    echo "Error: PENUMBRA_ZONE_WEB_PATH is not set or does not point to a valid directory."
    exit 1
fi

# Check if `ZAFU_REPO_PATH` is set and points to a valid directory
if [ -z "$ZAFU_REPO_PATH" ] || [ ! -d "$ZAFU_REPO_PATH" ]; then
    echo "Error: ZAFU_REPO_PATH is not set or does not point to a valid directory."
    exit 1
fi

# Repack the packages in `penumbra-zone/web`
repack() {
  (cd "$PENUMBRA_ZONE_WEB_PATH" && ./pack-public.sh)
}

# Install dependencies in the Zafu repo
install_zafu() {
  (cd "$ZAFU_REPO_PATH" && pnpm add -w $PENUMBRA_ZONE_WEB_PATH/packages/*/penumbra-zone-*-*.tgz)
}

# Reload webpack
reload_webpack() {
  # Find the PID of the actively running webpack process 
  WEBPACK_PID=$(lsof -t -i:5175) 

  if [ -n "$WEBPACK_PID" ]; then
    kill -9 $WEBPACK_PID
  fi
  
  (cd "$ZAFU_REPO_PATH" && pnpm run dev &)
}

# Watch for changes in `penumbra-zone/web` and trigger repack and reload
while sleep 1; do
  fswatch -1 -o "$PENUMBRA_ZONE_WEB_PATH/packages" | while read -r; do
    repack
    install_zafu
    reload_webpack
    break
  done
done