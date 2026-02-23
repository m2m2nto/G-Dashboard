# Global Codex Guidance

Applies to every Codex session on this machine; defer to repo or subdirectory AGENTS.md when they provide more specific instructions.

## How to use this file

* Skim once at the start of a session to align on global policies.
* Follow project or folder AGENTS.md files for task-specific commands and nuances.
* Ask the user when instructions conflict or feel unsafe.

## Operating mode

* Host: untouched unless user explicitly requests host changes. Assume you are running on a CachyOS host (Arch-based Linux).
* Execution: run deterministically, show diffs, prefer smallest verifiable unit (lint/typecheck/test). Stop on failure.
* Sensitive files: never touch `.env`, secrets, infra config, or production data without explicit instruction.

## Agent conduct

* Verify assumptions before executing commands; call out uncertainties first.
* Ask for clarification when the request is ambiguous, destructive, or risky.
* Summarize intent before performing multi-step fixes so the user can redirect early.
* Cite the source when using documentation; quote exact lines instead of paraphrasing from memory.
* Break work into incremental steps and confirm each step with the smallest relevant check before moving on.

## Documentation and MCP

* Use **Context7** via MCP for up-to-date, version-specific docs.
* Always `resolve-library-id` before `get-library-docs` unless ID is known.
* Fetch minimal targeted docs. Summarize inline; do not paste dumps.
* When API uncertainty remains: produce a runnable repro snippet and verify locally.
* If the needed documentation cannot be found, say so explicitly and explain the fallback approach.
* If you already know the Context7 library ID (e.g. `/supabase/supabase`), provide it directly to skip resolution.

## State & living docs

Maintain:

* `README.md` — stable overview.
* `HANDOFF.md` — current status for continuity.

Refresh triggers: contradictions, omissions, flaky tests, or version uncertainty.

Refresh includes:

* `README.md`: purpose, architecture, stack with versions, run instructions, changelog-lite.
* `HANDOFF.md`: current status, next steps, test results, artifacts, environment details.

## Commands and checks

* Show plan before large edits.
* Capture exit codes and logs.
* Run impacted checks only:
  * lint → changed files
  * typecheck → touched modules
  * test → nearest tests, expand only if upstream failure
* Stop on failure; summarize root cause; propose smallest fix.
* If no automated checks apply, make that explicit and describe what manual validation was performed.
* After each incremental change, execute the quickest verifying command from the applicable AGENTS.md (for example, a focused test or lint target) before tackling the next task.

## Fix and test

* whenver you are requested to fix a bug, ask is the bug has been resolved
* once the fix is done, write a test for it to avoid having it again in the future