# Release Runbook — G-Dashboard

Failure modes extracted from the last ~10 release sessions, with detection signals and recovery actions. The `release-engineer` subagent at `.claude/agents/release-engineer.md` is expected to detect and recover from each of these without human intervention.

## Pipeline phases

```text
preflight → test → bump build → electron build → verify .app
         → deploy + verify (project root AND /Applications) → commit
         → push (GitLab only) → zip → GitHub release upload
```

## Remote map — read this before any push

| Remote | URL | What it is | What may be pushed to it |
|---|---|---|---|
| `gitlab` | `repository.mobiledatacollection.it/ddaversa/g-dashboard.git` | **private, full history.** `main` tracks this | everything — this is the code remote |
| `origin` | `github.com/m2m2nto/G-Dashboard.git` | **PUBLIC.** Holds one squashed snapshot and the release assets | **nothing.** No branch, no history, ever |
| `gitlab-old` | `.../gulliver-lux-dashboard.git` | superseded clone | nothing |

`origin` is the *public* remote despite the conventional name — the private history
lives on `gitlab`. `main` is ~200 commits ahead of the public snapshot, so
`git push origin main` publishes the company's full financial history. That happened on
2026-08-12 (real balances, IBANs, salaries in the audit log) and the history had to be
replaced. **The release pipeline never pushes to `origin`.** GitHub receives release
artifacts only, through `gh release create` (phase 11), which needs no push access to
branches.

There is no `github` remote. Any instruction to "push GitHub" is stale — releases reach
GitHub through phase 11 alone.

## Failure → recovery table

| # | Failure mode | Detection signal | Recovery action |
|---|---|---|---|
| 1 | `npm install` hangs (>15 min) | no output from the staging install step for minutes | kill it, run `npm cache verify`, retry with `--registry https://registry.npmjs.org/`; if still failing >15 min, abort and surface. Usually a misconfigured or unreachable registry in the local npm config |
| 2 | Apple Dev cert signing rejected by Gatekeeper | `spctl --assess --type execute G-Dashboard.app` returns "rejected", or app fails to launch with "damaged" error | rebuild with `CSC_IDENTITY_AUTO_DISCOVERY=false` (already default in `build-electron.sh`), then `xattr -cr G-Dashboard.app` to clear quarantine attributes |
| 3 | `gitlab` remote unreachable (VPN/network) | `git push gitlab` exits non-zero with "Could not resolve host", "Connection refused", or "timed out" | retry with exponential backoff: 10s, 30s, 90s (max 3 tries). If still failing, abort the push step and surface clearly. Never "route around" a failing `gitlab` by pushing another remote — see the remote map |
| 4 | Nested `.app` from `cp -R` | `find G-Dashboard.app -mindepth 1 -maxdepth 3 -name 'G-Dashboard.app' -type d` returns a result. **`-mindepth 1` is load-bearing**: `find` starts at depth 0 with the path itself, so without it the check matches the bundle it was handed and reports nesting on every healthy build — see the note below | `rm -rf G-Dashboard.app`, then use `ditto "$src" "$dst"` (not `cp -R`) |
| 5 | Divergent remote (main behind/ahead) | `git status -sb` shows `ahead N, behind M` after `git fetch` | `git fetch --all` → if behind only, `git rebase gitlab/main`; if behind + ahead with conflicts, abort and surface (manual resolution). Never rebase onto `origin/main` — it is the squashed public snapshot, not this history |
| 6 | `$N` backreference / unescaped variable in scripts | build script output contains literal `$1`, `$2`, etc., or sed prints raw `&` | scripts must single-quote `sed` patterns and escape `$` in heredocs. Already fixed in `build-electron.sh`; verify by grep before editing scripts |
| 7 | `onedir`/path layout drift in `electron-builder` output | `dashboard/dist/electron/mac-arm64/G-Dashboard.app` missing after build | `find dashboard/dist/electron -maxdepth 4 -name 'G-Dashboard.app' -type d` to locate; if found elsewhere, copy from the actual path and log a warning so the runbook can be updated |
| 8 | `npm test` flake (rare) | single test fails on first run, passes on rerun | rerun the failing test file once. If still fails, treat as real failure and abort |
| 9 | GitHub release tag already exists | `gh release create` exits with "release already exists" | this means a previous run partially completed. Run `gh release view <tag> --repo <releases-repo from dashboard/release.config.json>`; if asset is missing, `gh release upload <tag> <zip> --clobber`; if asset present, the release is already done — skip |
| 10 | `gh` not authenticated | `gh auth status` non-zero | surface clearly and abort — cannot self-recover, needs interactive `gh auth login` |
| 11 | Installed `/Applications` copy won't launch ("`G-Dashboard.app` can't be opened" Finder dialog) | `ls -l /Applications/G-Dashboard.app/Contents/MacOS/G-Dashboard` shows no `x` bit (e.g. `-rw-------`), and/or `codesign --verify --deep --strict /Applications/G-Dashboard.app` exits non-zero ("code object is not signed at all"). The bundle binary often still runs from the CLI, so check perms + signature, not just "does it run" | the bundle was copied with a lossy method (`cp -R`, a Finder drag, or unzip that dropped the +x bit / signature). Quit it (`osascript -e 'quit app "G-Dashboard"'`), then reinstall from the verified source: `rm -rf /Applications/G-Dashboard.app && ditto "$SRC" /Applications/G-Dashboard.app && xattr -cr /Applications/G-Dashboard.app`. Confirm `test -x .../Contents/MacOS/G-Dashboard` and `codesign --verify --deep --strict` exits 0 |

## Preflight checks (run before any release step)

1. `git fetch --all --prune` — pull latest refs.
2. `git status -sb` — confirm clean working tree (no unstaged/uncommitted changes apart from `package.json` if mid-flow). If dirty, abort.
3. Compare `HEAD` against `gitlab/main` — that is the branch `main` tracks. Rebase if behind. Ignore `origin/main`; it is the public squashed snapshot and will always look wildly divergent.
4. `gh auth status` — confirm authenticated.
5. Probe GitLab reachability with `git ls-remote --exit-code gitlab HEAD`. If it fails, surface a warning but proceed through tests/build; only block at the push phase.

   Run it bare. **Do not wrap it in `timeout`** — that binary ships with GNU coreutils and is
   not present on stock macOS, so the wrapper exits 127 and the probe reports UNREACHABLE
   whatever the network is doing (see the false-signal note at the bottom). Git's own
   `core.askPass`/credential settings already prevent an indefinite hang on a private host. If
   you genuinely need a bound, guard it: `command -v gtimeout >/dev/null && gtimeout 5 …`.

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

One push, one remote: `git push gitlab main`. Nothing else is pushed, in any phase, for any
reason. See the remote map above for why `origin` is excluded — it is the public repo, and a
push there leaks the full private history.

If `gitlab` is unreachable, retry per table row 3 and then abort. A failed `gitlab` push is
never a reason to try a different remote.

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
  not the network. Verify before acting on either. **Root cause found 2026-08-13, during the
  build-85 release:** the probe was specified with a "5s timeout", so agents composed
  `timeout 5 git ls-remote …`; `timeout` does not exist on macOS, the shell returned 127, and the
  `||` branch printed UNREACHABLE on every run — while `git fetch gitlab` in the same command had
  just succeeded. Preflight step 5 now says to run the probe bare. Same shape as the `-mindepth 1`
  bug: a detector that cannot report success, wired to a costly recovery.
- **The remote names in this file were wrong until 2026-08-13** — it called `origin` the private
  primary and told the pipeline to push it first. In this clone `origin` is the *public* GitHub
  repo. An agent following the old text literally would have published ~200 commits of private
  financial history, re-creating the 2026-08-12 exposure. The build-85 release stopped at preflight
  only because the agent cross-checked `git remote -v` against the prose instead of trusting it.
  If these two ever disagree again, `git remote -v` wins and the doc is the bug.
