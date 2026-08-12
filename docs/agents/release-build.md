# Release & Build — G-Dashboard

Moved out of `CLAUDE.md` so it loads only when a release is actually being run.
Failure modes and their recoveries live in `docs/agents/release-runbook.md`; the
`release-engineer` agent (`/ship`) drives the whole pipeline.

## Version & Build Management

Version and build number live in `dashboard/package.json`:
- `"version"` — semver, for example `"1.1.0"`; bump for feature releases
- `"buildNumber"` — integer build counter, for example `42`; **increment on every build**

Both are injected at build time via Vite `define` (`__APP_VERSION__`, `__APP_BUILD__`) and displayed in the Settings panel footer as `GL-Dashboard v1.1.0 (build 42)`.

## Build & Release Workflow

Every time we push to main, follow this sequence **in order**. Do **not** push until the build is complete:

1. **Run all tests**: `npm test`. If any fail, **stop and fix before continuing**.
2. **Increment the `"buildNumber"`** in `dashboard/package.json`.
3. **Build the Electron/macOS app**: `bash scripts/build-electron.sh` from `dashboard/`.
4. **Replace the `.app` at the project root** (use `ditto`, never `cp -R`):
   ```bash
   rm -rf G-Dashboard.app && ditto dashboard/dist/electron/mac-arm64/G-Dashboard.app G-Dashboard.app
   xattr -cr G-Dashboard.app
   ```
   The `rm -rf` is required because `cp -R` (and bare `ditto src dst/`) merge into an existing directory instead of replacing it — at best leaving stale timestamps, at worst producing a nested `G-Dashboard.app/G-Dashboard.app`. `ditto` preserves macOS metadata and bundle integrity; `xattr -cr` clears any quarantine flag so Gatekeeper does not block first launch. This is a **local deployment** step so the user can run the latest build directly; it must happen every time.
5. **Commit the buildNumber change and push** only after the build succeeds and the `.app` copy is in place.
6. **Upload to GitHub releases** for auto-update distribution:
   ```bash
   # Copy and rename the zip for the release
   cp dashboard/dist/electron/G-Dashboard-{version}-arm64-mac.zip /tmp/G-Dashboard-v{version}-build.{buildNumber}.zip

   # Create the release on the dedicated releases repo
   gh release create v{version}-build.{buildNumber} \
     /tmp/G-Dashboard-v{version}-build.{buildNumber}.zip \
     --repo "$(node -p "const c=require('./dashboard/release.config.json'); c.updateRepoOwner+'/'+c.updateRepoName")" \
     --title "G-Dashboard {version} (build {buildNumber})" \
     --notes "G-Dashboard v{version} build {buildNumber}" \
     --latest
   ```
   Replace `{version}` and `{buildNumber}` with actual values from `package.json`. `scripts/create-release.sh` does all of the above and reads the repo for you. The releases repo is per-installation config in `dashboard/release.config.json` (gitignored; copy `release.config.example.json`) — a clone without it has auto-update disabled and skips this step.

**Important**: The `G-Dashboard.app` at the project root is **not tracked by git** — never commit it. It is a local build artifact for the user to run.

The build script handles the client build automatically, reads version and build from `package.json`, and injects them into the Electron app.

**This is mandatory**: the Electron build and `.app` copy must happen **before** committing and pushing so that every commit on main corresponds to a verified, working desktop build.

## Build Hygiene

- Never use `cp -R` for .app bundles (creates nested .app); use `ditto` or `rsync -a --delete`.
- Ship release builds as unsigned/ad-hoc with xattr instructions, NOT with Apple Development certs (Gatekeeper rejects them).
- If `npm install` hangs >5 minutes, abort and retry — likely a custom registry/VPN issue.
- Deploy the build to **both** the project root and `/Applications` (the copy the user launches) with `ditto`, then **verify the deployed copy is launchable**: `test -x .../Contents/MacOS/G-Dashboard` (execute bit survived) and `codesign --verify --deep --strict` exits 0. A `cp -R` / Finder drag / lossy unzip can strip the +x bit and break the signature, producing the macOS "G-Dashboard.app can't be opened" dialog even though the binary still runs from the CLI.
