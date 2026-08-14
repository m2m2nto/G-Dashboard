#!/bin/bash
set -euo pipefail

# Build Electron app for G-Dashboard
# Run from dashboard/ directory: bash scripts/build-electron.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DASHBOARD_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STAGING_DIR="$DASHBOARD_DIR/.electron-staging"

# Skip code signing (personal use only, no distribution certificate needed)
export CSC_IDENTITY_AUTO_DISCOVERY=false

echo "=== Building G-Dashboard Electron App ==="
echo "Dashboard dir: $DASHBOARD_DIR"
cd "$DASHBOARD_DIR"

# -------------------------------------------------------------------
# 1. Build the client
# -------------------------------------------------------------------
echo ""
echo "--- Building client ---"
npm run build --workspace=client

# -------------------------------------------------------------------
# 2. Stage server production dependencies
# -------------------------------------------------------------------
echo ""
echo "--- Staging server dependencies ---"
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
cp "$DASHBOARD_DIR/server/package.json" "$STAGING_DIR/"
cd "$STAGING_DIR"
npm install --omit=dev
cd "$DASHBOARD_DIR"

# -------------------------------------------------------------------
# 3. Create build/ directory with placeholder icon if missing
# -------------------------------------------------------------------
if [ ! -d "$DASHBOARD_DIR/build" ]; then
  echo ""
  echo "--- Creating build/ directory (no custom icon) ---"
  mkdir -p "$DASHBOARD_DIR/build"
fi

# -------------------------------------------------------------------
# 4. Run electron-builder
# -------------------------------------------------------------------
echo ""
echo "--- Running electron-builder ---"
npx electron-builder --mac

# -------------------------------------------------------------------
# 5. Prune old release artifacts
# -------------------------------------------------------------------
# electron-builder names every artifact after the version, so a build adds four
# files rather than replacing the previous ones, and nothing ever removed them.
# That grows by ~290 MB per release; it had reached 1.8 GB of builds going back
# to February before this step existed.
#
# Newest by mtime, not highest version number: rebuilding an older version then
# has the same predictable effect as building a new one. The unpacked
# `mac-arm64/` is never touched — it is the build output the release pipeline
# deploys and zips, and it is overwritten by each build anyway.
KEEP_BUILDS="${KEEP_BUILDS:-2}"
OUT_DIR="$DASHBOARD_DIR/dist/electron"

echo ""
echo "--- Pruning old artifacts (keeping the newest $KEEP_BUILDS) ---"
# `|| true` because `ls` exits non-zero on no match, and `set -o pipefail`
# would take the whole build down with it on a first-ever build.
dmgs="$(ls -t "$OUT_DIR"/*-arm64.dmg 2>/dev/null || true)"
if [ -n "$dmgs" ]; then
  echo "$dmgs" | tail -n "+$((KEEP_BUILDS + 1))" | while read -r dmg; do
    stem="${dmg%-arm64.dmg}"
    echo "  removing $(basename "$stem")"
    rm -f "$stem-arm64.dmg" "$stem-arm64.dmg.blockmap" \
          "$stem-arm64-mac.zip" "$stem-arm64-mac.zip.blockmap"
  done
fi

# -------------------------------------------------------------------
# 6. Clean up staging
# -------------------------------------------------------------------
echo ""
echo "--- Cleaning up ---"
rm -rf "$STAGING_DIR"

echo ""
echo "=== Build complete ==="
echo "Output: $DASHBOARD_DIR/dist/electron/"
ls -la "$DASHBOARD_DIR/dist/electron/" 2>/dev/null || true
