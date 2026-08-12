#!/bin/bash
set -euo pipefail

# Repair /Applications/G-Dashboard.app when an auto-update leaves it
# unlaunchable ("cannot be opened because of a problem"). This happens
# because the app is ad-hoc signed and Squirrel sometimes invalidates
# nested framework signatures during the swap.
#
# Usage: bash scripts/fix-installed-app.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DASHBOARD_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$DASHBOARD_DIR/.." && pwd)"

SOURCE_APP="$PROJECT_ROOT/G-Dashboard.app"
TARGET_APP="/Applications/G-Dashboard.app"

if [ ! -d "$SOURCE_APP" ]; then
  echo "Source bundle not found: $SOURCE_APP"
  echo "Run scripts/build-electron.sh and copy the build to the project root first."
  exit 1
fi

if ! codesign --verify --deep --strict "$SOURCE_APP" 2>/dev/null; then
  echo "Source bundle signature is invalid: $SOURCE_APP"
  echo "Rebuild before running this script."
  exit 1
fi

echo "=== Repairing $TARGET_APP ==="

# Kill any running instance so we can replace the bundle cleanly
if pgrep -f "G-Dashboard.app/Contents/MacOS/G-Dashboard" >/dev/null; then
  echo "--- Stopping running G-Dashboard ---"
  pkill -f "G-Dashboard.app/Contents/MacOS/G-Dashboard" || true
  sleep 1
fi

echo "--- Replacing bundle ---"
rm -rf "$TARGET_APP"
cp -R "$SOURCE_APP" "$TARGET_APP"

echo "--- Clearing quarantine ---"
xattr -dr com.apple.quarantine "$TARGET_APP" 2>/dev/null || true

echo "--- Verifying signature ---"
codesign --verify --deep --strict --verbose=2 "$TARGET_APP"

echo ""
echo "=== Done. Launch G-Dashboard from /Applications. ==="
