---
description: Run the full G-Dashboard release pipeline (tests → build → push GitLab+GitHub → GitHub release) via the release-engineer subagent.
argument-hint: "[optional release notes]"
---

**First, get the version approved — the subagent cannot talk to the user.**

1. Read the current `"version"` from `dashboard/package.json` and list the commits since the last release tag (`git log --oneline $(git describe --tags --abbrev=0 2>/dev/null)..HEAD`).
2. Classify them per the `major.minor.bugfix` rules in `docs/agents/release-build.md` and propose the new version to the user:

   ```text
   Proposed version: <current> → <proposed> (<major|minor|bugfix>)
   Reason: <one line>
   Commits since <last tag>: <short list>
   OK to ship as <proposed>?
   ```

3. Wait for the user's answer. If they name a different number, use theirs. Do not proceed without an explicit OK.

Then delegate to the `release-engineer` subagent. The agent has the full procedure and failure-mode runbook; do not duplicate steps here — let the agent drive.

Use the Agent tool with `subagent_type: "release-engineer"` and this prompt:

```
Run the full G-Dashboard release pipeline as defined in your agent definition and docs/agents/release-runbook.md. Execute all 11 phases in order, apply only documented recoveries, and end with the summary block.

APPROVED VERSION: <the version the user approved> — stamp this into dashboard/package.json in phase 3 alongside the buildNumber bump.

Optional release notes from user (use verbatim in the GitHub release body if non-empty, otherwise use the default):
$ARGUMENTS
```

After the agent returns, relay its summary block to the user as the final response. Do not re-run any phase yourself.
