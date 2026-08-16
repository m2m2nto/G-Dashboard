# Release Runbook — G-Dashboard

Failure modes extracted from the last ~10 release sessions, with detection signals and recovery actions. The `release-engineer` subagent at `.claude/agents/release-engineer.md` is expected to detect and recover from each of these without human intervention.

## Pipeline phases

```text
preflight → test → bump build → electron build → verify .app
         → deploy + verify (project root AND /Applications) → commit
         → push (GitLab + GitHub) → zip → GitHub release upload
```

## Failure → recovery table

| # | Failure mode | Detection signal | Recovery action |
|---|---|---|---|
| 1 | `npm install` hangs (>15 min) | no output from the staging install step for minutes | kill it, run `npm cache verify`, retry with `--registry https://registry.npmjs.org/`; if still failing >15 min, abort and surface. Usually a misconfigured or unreachable registry in the local npm config |
| 2 | Apple Dev cert signing rejected by Gatekeeper | `spctl --assess --type execute G-Dashboard.app` returns "rejected", or app fails to launch with "damaged" error | rebuild with `CSC_IDENTITY_AUTO_DISCOVERY=false` (already default in `build-electron.sh`), then `xattr -cr G-Dashboard.app` to clear quarantine attributes |
| 3 | Primary `origin` remote unreachable (VPN/network) | `git push origin` exits non-zero with "Could not resolve host", "Connection refused", or "timed out" | retry with exponential backoff: 10s, 30s, 90s (max 3 tries). If still failing, abort the push step and surface clearly — do NOT skip `origin` and continue to a secondary remote |
| 4 | Nested `.app` from `cp -R` | `find G-Dashboard.app -mindepth 1 -maxdepth 3 -name 'G-Dashboard.app' -type d` returns a result. **`-mindepth 1` is load-bearing**: `find` starts at depth 0 with the path itself, so without it the check matches the bundle it was handed and reports nesting on every healthy build — see the note below | `rm -rf G-Dashboard.app`, then use `ditto "$src" "$dst"` (not `cp -R`) |
| 5 | Divergent remote (main behind/ahead) | `git status -sb` shows `ahead N, behind M` after `git fetch` | `git fetch --all` → if behind only, `git rebase origin/main`; if behind + ahead with conflicts, abort and surface (manual resolution) |
| 6 | `$N` backreference / unescaped variable in scripts | build script output contains literal `$1`, `$2`, etc., or sed prints raw `&` | scripts must single-quote `sed` patterns and escape `$` in heredocs. Already fixed in `build-electron.sh`; verify by grep before editing scripts |
| 7 | `onedir`/path layout drift in `electron-builder` output | `dashboard/dist/electron/mac-arm64/G-Dashboard.app` missing after build | `find dashboard/dist/electron -maxdepth 4 -name 'G-Dashboard.app' -type d` to locate; if found elsewhere, copy from the actual path and log a warning so the runbook can be updated |
| 8 | `npm test` flake (rare) | single test fails on first run, passes on rerun | rerun the failing test file once. If still fails, treat as real failure and abort |
| 9 | GitHub release tag already exists | `gh release create` exits with "release already exists" | this means a previous run partially completed. Run `gh release view <tag> --repo <releases-repo from dashboard/release.config.json>`; if asset is missing, `gh release upload <tag> <zip> --clobber`; if asset present, the release is already done — skip |
| 10 | `gh` not authenticated | `gh auth status` non-zero | surface clearly and abort — cannot self-recover, needs interactive `gh auth login` |
| 11 | Installed `/Applications` copy won't launch ("`G-Dashboard.app` can't be opened" Finder dialog) | `ls -l /Applications/G-Dashboard.app/Contents/MacOS/G-Dashboard` shows no `x` bit (e.g. `-rw-------`), and/or `codesign --verify --deep --strict /Applications/G-Dashboard.app` exits non-zero ("code object is not signed at all"). The bundle binary often still runs from the CLI, so check perms + signature, not just "does it run" | the bundle was copied with a lossy method (`cp -R`, a Finder drag, or unzip that dropped the +x bit / signature). Quit it (`osascript -e 'quit app "G-Dashboard"'`), then reinstall from the verified source: `rm -rf /Applications/G-Dashboard.app && ditto "$SRC" /Applications/G-Dashboard.app && xattr -cr /Applications/G-Dashboard.app`. Confirm `test -x .../Contents/MacOS/G-Dashboard` and `codesign --verify --deep --strict` exits 0 |

## Preflight checks (run before any release step)

1. `git fetch --all --prune` — pull latest refs.
2. `git status -sb` — confirm clean working tree (no unstaged/uncommitted changes apart from `package.json` if mid-flow). If dirty, abort.
3. Compare `HEAD` against `origin/main` and `github/main` (if both remotes exist). Rebase if behind.
4. `gh auth status` — confirm authenticated.
5. Probe GitLab reachability with a short-timeout `git ls-remote origin HEAD` (5s timeout). If it fails, surface a warning but proceed through tests/build; only block at the push phase.

## Verify `.app` structure (after build, before commit)

```bash
SRC=dashboard/dist/electron/mac-arm64/G-Dashboard.app

# 1. Source exists and is a real bundle
test -d "$SRC/Contents/MacOS" || abort "build did not produce expected .app layout"

# 2. Signature is ad-hoc / unsigned (not Apple Dev cert)
codesign -dv "$SRC" 2>&1 | grep -E 'Signature=adhoc|code object is not signed' || \
  echo "WARN: app has non-adhoc signature; Gatekeeper may reject"
```

## Deploy + verify (after build, before commit)

Deploy to **both** the project-root artifact and the **`/Applications`** install the user double-clicks. A copy is not "done" until the deployed bundle is proven launchable — the executable bit and signature must survive the copy (runbook #11).

```bash
deploy_app() {
  local dst="$1"
  rm -rf "$dst"
  ditto "$SRC" "$dst"            # ditto preserves perms + symlinks + signature; NEVER cp -R / Finder drag
  xattr -cr "$dst"
  test -d "$dst/Contents/MacOS"               || abort "$dst missing MacOS dir"
  ! test -d "$dst/G-Dashboard.app"            || abort "nested .app at $dst"
  test -x "$dst/Contents/MacOS/G-Dashboard"   || abort "$dst executable lost its +x bit"
  codesign --verify --deep --strict "$dst"    || abort "$dst signature broken after copy"
}

osascript -e 'quit app "G-Dashboard"' 2>/dev/null   # release a running /Applications copy
deploy_app G-Dashboard.app
deploy_app /Applications/G-Dashboard.app
```

## Push order

Push `origin` first (required, primary). If the installation also configures a secondary
releases mirror remote, push it second and never before `origin` succeeded — that keeps the
remotes aligned. A clone with a single `origin` just pushes once.

## Notes

- This runbook is the source of truth for `.claude/agents/release-engineer.md`. When a new failure mode appears, add it here first, then update the agent.
- The agent should treat the table above as authoritative and refuse to invent new recoveries silently. If it sees a failure not in the table, it must abort and surface.
- **The nested-`.app` detector used to fire on every healthy build (fixed 2026-08-11, found during the build-80 release).** It read
  `find G-Dashboard.app -maxdepth 2 -name 'G-Dashboard.app'`, and `find` starts at depth 0 with the
  path it is given — so the bundle matched its own name and the check reported nesting every time.
  That matters more than a noisy log, because the recovery for #4 is `rm -rf G-Dashboard.app`: an
  agent trusting the signal would delete a perfectly good bundle to fix a problem that was never
  there. `-mindepth 1` is what makes it a real check. The `deploy_app` guard at line 61
  (`! test -d "$dst/G-Dashboard.app"`) was always correct and is unchanged.
- Related false signal, same family: a "remote UNREACHABLE" preflight result is usually the probe,
  not the network. Verify before acting on either.
