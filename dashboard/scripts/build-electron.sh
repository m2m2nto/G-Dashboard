#!/bin/bash
set -euo pipefail

# Build Electron app for GL-Dashboard
# Run from dashboard/ directory: bash scripts/build-electron.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DASHBOARD_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STAGING_DIR="$DASHBOARD_DIR/.electron-staging"

echo "=== Building GL-Dashboard Electron App ==="
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
# 5. Clean up staging
# -------------------------------------------------------------------
echo ""
echo "--- Cleaning up ---"
rm -rf "$STAGING_DIR"

echo ""
echo "=== Build complete ==="
echo "Output: $DASHBOARD_DIR/dist/electron/"
ls -la "$DASHBOARD_DIR/dist/electron/" 2>/dev/null || true
