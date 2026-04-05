# G-Dashboard

> **This project is experimental.** It is not intended for production use.

## What is this

G-Dashboard is a desktop financial management app — but more importantly, it is an **experiment in building software almost entirely through AI code agents**.

The project was started to explore how far you can push [Claude Code](https://claude.ai/code) as the primary development tool: writing features, fixing bugs, managing builds, and iterating on a real codebase over time. The app itself is functional and useful, but the real goal is the process, not the product.

## Why this project

### Excel as the source of truth

Most financial tooling assumes a database. This project deliberately uses **Excel files as the primary data store** — reading and writing `.xlsx` directly, preserving formulas and charts. This creates an interesting challenge for AI agents: manipulating XML inside zip archives, handling table range updates, and respecting formula cells that must never be overwritten.

### Expanding agent capabilities

The codebase has grown through continuous conversation with Claude Code, testing the boundaries of what a code agent can do:

- **Full-stack development** — React frontend, Express backend, Electron desktop shell, all built and maintained by the agent
- **Excel file manipulation** — Low-level XML/ZIP operations that require understanding of the OOXML format
- **Build and release automation** — The agent handles version bumping, Electron builds, code signing, and GitHub release uploads
- **Bug diagnosis and regression testing** — Every bug fix includes a test, written and verified by the agent

### Practicing agent communication

This project is also a testbed for **how humans and AI agents collaborate over time**:

- Refining prompts and instructions (the `CLAUDE.md` file) to get consistent, high-quality output
- Using **memory systems** to maintain context across conversations — preferences, decisions, project history
- Experimenting with different agent strategies: planning before coding, parallel sub-agents for research, iterative refinement vs. single-pass implementation
- Learning what to delegate fully vs. what needs human steering

## The app itself

G-Dashboard tracks banking transactions, cash flow projections, and budgets. It reads and writes Excel workbooks that serve as both storage and reporting layer. Features include:

- Transaction management with automatic category suggestions
- Cash flow visualization synced from transaction data
- Multi-scenario budget planning and projections
- Year-over-year analytics dashboards
- Activity audit log with full traceability
- Built-in auto-update mechanism

## Tech stack

| Layer | Technology |
|-------|-----------|
| Desktop | Electron (macOS) |
| Frontend | React 19, Vite 6, Tailwind CSS 3 |
| Backend | Express 4 (Node.js) |
| Storage | Excel files (ExcelJS + xlsx-populate + JSZip) |
| Tests | Node.js built-in test runner |
| Dev tool | Claude Code |

## About this repository

This repo contains the source code and hosts release builds for auto-update distribution. Releases are published as GitHub Releases.

---

**Experimental** — No stability guarantees, no migration paths, breaking changes expected. This is a learning project first and a tool second.