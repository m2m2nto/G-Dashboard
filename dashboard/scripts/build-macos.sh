#!/bin/bash
set -euo pipefail

# Build macOS .app bundle for GL-Dashboard
# Run from dashboard/ directory: bash scripts/build-macos.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DASHBOARD_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME="GL-Dashboard"
DIST_DIR="$DASHBOARD_DIR/dist"
APP_DIR="$DIST_DIR/$APP_NAME.app"
CONTENTS="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"

echo "=== Building $APP_NAME.app ==="
echo "Dashboard dir: $DASHBOARD_DIR"

# -------------------------------------------------------------------
# 1. Build the client
# -------------------------------------------------------------------
echo ""
echo "--- Building client ---"
cd "$DASHBOARD_DIR"
npm run build --workspace=client

# -------------------------------------------------------------------
# 2. Clean previous build
# -------------------------------------------------------------------
echo ""
echo "--- Preparing .app structure ---"
rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES/server" "$RESOURCES/public"

# -------------------------------------------------------------------
# 3. Copy server files (excluding tests, data, node_modules)
# -------------------------------------------------------------------
echo "Copying server files..."
cp "$DASHBOARD_DIR/server/index.js"  "$RESOURCES/server/"
cp "$DASHBOARD_DIR/server/config.js" "$RESOURCES/server/"
mkdir -p "$RESOURCES/server/routes"
cp "$DASHBOARD_DIR/server/routes/"*.js "$RESOURCES/server/routes/"
mkdir -p "$RESOURCES/server/services"
cp "$DASHBOARD_DIR/server/services/"*.js "$RESOURCES/server/services/"

# -------------------------------------------------------------------
# 4. Copy built client → Resources/public/
# -------------------------------------------------------------------
echo "Copying built client..."
cp -R "$DASHBOARD_DIR/client/dist/"* "$RESOURCES/public/"

# -------------------------------------------------------------------
# 5. Install production dependencies in Resources/
# -------------------------------------------------------------------
echo "Installing production dependencies..."
cp "$DASHBOARD_DIR/server/package.json" "$RESOURCES/"
cd "$RESOURCES"
npm install --omit=dev
cd "$DASHBOARD_DIR"

# -------------------------------------------------------------------
# 6. Generate Info.plist
# -------------------------------------------------------------------
echo "Generating Info.plist..."
cat > "$CONTENTS/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>GL-Dashboard</string>
  <key>CFBundleDisplayName</key>
  <string>GL-Dashboard</string>
  <key>CFBundleIdentifier</key>
  <string>com.gl-dashboard.app</string>
  <key>CFBundleVersion</key>
  <string>1.0.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>LSMinimumSystemVersion</key>
  <string>10.15</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

# -------------------------------------------------------------------
# 7. Create launcher script
# -------------------------------------------------------------------
echo "Creating launcher script..."
cat > "$MACOS_DIR/launcher" << 'LAUNCHER'
#!/bin/bash

# GL-Dashboard launcher
# This script is the entry point when the .app is double-clicked.

# --- Resolve paths ---
BUNDLE_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RESOURCES="$BUNDLE_DIR/Contents/Resources"
DATA_DIR="$(cd "$BUNDLE_DIR/.." && pwd)"

# --- Find Node.js ---
# Source shell profile to pick up nvm, homebrew, etc.
for profile in "$HOME/.zprofile" "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.profile"; do
  [ -f "$profile" ] && source "$profile" 2>/dev/null
done

# Also check common Node locations
for p in /usr/local/bin /opt/homebrew/bin "$HOME/.nvm/versions/node"/*/bin; do
  [ -d "$p" ] && export PATH="$p:$PATH"
done

if ! command -v node &>/dev/null; then
  osascript -e 'display alert "Node.js not found" message "GL-Dashboard requires Node.js to run.\n\nPlease install it from https://nodejs.org or via Homebrew:\n  brew install node" as critical buttons {"OK"}'
  exit 1
fi

NODE_PATH="$(command -v node)"
NODE_VERSION="$(node --version)"

# --- Set environment variables ---
export GULLIVER_DATA_DIR="$DATA_DIR"
export GULLIVER_APP_DIR="$RESOURCES"
export NODE_ENV="production"

# --- Launch server in Terminal ---
# Create a temporary script for Terminal to run
LAUNCH_SCRIPT=$(mktemp /tmp/gulliver-launch.XXXXXX.sh)
cat > "$LAUNCH_SCRIPT" << SCRIPT
#!/bin/bash
# Source profile for Node path
for profile in "\$HOME/.zprofile" "\$HOME/.zshrc" "\$HOME/.bash_profile" "\$HOME/.bashrc" "\$HOME/.profile"; do
  [ -f "\$profile" ] && source "\$profile" 2>/dev/null
done
for p in /usr/local/bin /opt/homebrew/bin "\$HOME/.nvm/versions/node"/*/bin; do
  [ -d "\$p" ] && export PATH="\$p:\$PATH"
done

export GULLIVER_DATA_DIR="$DATA_DIR"
export GULLIVER_APP_DIR="$RESOURCES"
export NODE_ENV="production"

clear
echo "========================================"
echo "  GL-Dashboard"
echo "========================================"
echo ""
echo "  Node:    $NODE_VERSION ($NODE_PATH)"
echo "  Data:    $DATA_DIR"
echo "  Server:  http://localhost:3001"
echo ""
echo "  Press Ctrl+C to stop the server"
echo "========================================"
echo ""

cd "$RESOURCES"
exec node server/index.js
SCRIPT
chmod +x "$LAUNCH_SCRIPT"

# Open Terminal with the server
osascript -e "tell application \"Terminal\"
  activate
  do script \"bash '$LAUNCH_SCRIPT'; rm -f '$LAUNCH_SCRIPT'\"
end tell"

# --- Wait briefly for server to start, then open browser ---
sleep 2
open "http://localhost:3001"
LAUNCHER
chmod +x "$MACOS_DIR/launcher"

# -------------------------------------------------------------------
# Done
# -------------------------------------------------------------------
echo ""
echo "=== Build complete ==="
echo "Output: $APP_DIR"
echo ""
echo "To use: copy \"$APP_NAME.app\" next to your Excel files and double-click."
