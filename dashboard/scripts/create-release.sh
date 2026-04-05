#!/bin/bash
set -euo pipefail

# Create a GitHub release and upload the .app as a ZIP
# Run from dashboard/: bash scripts/create-release.sh
#
# Prerequisites:
#   - gh CLI installed (brew install gh)
#   - gh auth login (once)
#   - Public GitHub repo: ddaversa/g-dashboard-releases

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DASHBOARD_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$DASHBOARD_DIR/.." && pwd)"

REPO="m2m2nto/g-dashboard-releases"
APP_PATH="$PROJECT_ROOT/G-Dashboard.app"

# -------------------------------------------------------------------
# 1. Read version + buildNumber from package.json
# -------------------------------------------------------------------
VERSION=$(node -p "require('$DASHBOARD_DIR/package.json').version")
BUILD=$(node -p "require('$DASHBOARD_DIR/package.json').buildNumber")
TAG="v${VERSION}-build.${BUILD}"

echo "=== Creating Release ==="
echo "Version: $VERSION"
echo "Build:   $BUILD"
echo "Tag:     $TAG"
echo "Repo:    $REPO"
echo ""

# -------------------------------------------------------------------
# 2. Verify .app exists
# -------------------------------------------------------------------
if [ ! -d "$APP_PATH" ]; then
  echo "ERROR: $APP_PATH not found."
  echo "Run the build first: bash scripts/build-electron.sh"
  exit 1
fi

# -------------------------------------------------------------------
# 3. Create ZIP of the .app
# -------------------------------------------------------------------
ZIP_NAME="G-Dashboard-${TAG}.zip"
ZIP_PATH="$PROJECT_ROOT/$ZIP_NAME"

echo "--- Creating ZIP: $ZIP_NAME ---"
cd "$PROJECT_ROOT"
# Use ditto to preserve macOS metadata and permissions
ditto -ck --sequesterRsrc --keepParent "G-Dashboard.app" "$ZIP_NAME"
echo "ZIP size: $(du -h "$ZIP_PATH" | cut -f1)"

# -------------------------------------------------------------------
# 4. Create GitHub release and upload asset
# -------------------------------------------------------------------
echo ""
echo "--- Creating GitHub release ---"
gh release create "$TAG" \
  --repo "$REPO" \
  --title "G-Dashboard $VERSION (build $BUILD)" \
  --notes "G-Dashboard v${VERSION} build ${BUILD}" \
  "$ZIP_PATH"

# -------------------------------------------------------------------
# 5. Clean up ZIP
# -------------------------------------------------------------------
rm -f "$ZIP_PATH"

echo ""
echo "=== Release created ==="
echo "https://github.com/$REPO/releases/tag/$TAG"
