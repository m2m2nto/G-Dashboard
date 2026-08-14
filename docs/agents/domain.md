# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **single-context**: one product (GL-Dashboard) with a single domain vocabulary, even though it's split across `dashboard/client/` and `dashboard/server/` workspaces.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the project glossary (created lazily by `/grill-with-docs` as terms get resolved).
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-*.md
│   └── 0002-*.md
└── dashboard/
    ├── client/
    └── server/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

For this repo specifically, common Italian-domain terms include the Italian month abbreviations (`GEN`, `FEB`, ...), CF category prefixes (`C-` for cost, `R-` for revenue), and EUR currency formatting — see `CLAUDE.md` for canonical conventions.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (...) — but worth reopening because…_
