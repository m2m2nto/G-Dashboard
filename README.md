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

## Building it yourself

Requirements: macOS, npm, and Node.js 20 or newer (developed and tested on Node 23).

```bash
git clone <your-fork-url> && cd G-Dashboard/dashboard
npm ci          # installs the server + client workspaces
npm test        # typecheck + server and client test suites
npm run dev     # server on :3001, Vite client with hot reload
```

To produce the macOS desktop app:

```bash
npm run electron:build          # → dashboard/dist/electron/mac-arm64/G-Dashboard.app
```

The build is unsigned (ad-hoc). On first launch macOS may refuse to open it; clear the
quarantine flag with `xattr -cr G-Dashboard.app`.

### Data files

The app does not ship with any data. On first run it walks you through selecting a project
folder containing your Excel workbooks and writes a `gl-project.json` manifest describing
them. The workbook layout the app expects is documented in
[`docs/consolidated-spec.md`](docs/consolidated-spec.md) and
[`dashboard/docs/specs/banking-transactions-file-spec.md`](dashboard/docs/specs/banking-transactions-file-spec.md).

### Auto-update (optional)

Auto-update is **off** unless you configure a releases repo. Copy
`dashboard/release.config.example.json` to `dashboard/release.config.json` (gitignored) and
point it at a GitHub repo you own. `dashboard/scripts/create-release.sh` then publishes
builds there, and the app checks it for updates. Without that file the app never contacts
any update server.

## About this repository

This repo contains the source code. Release builds are distributed separately as GitHub
Releases from whichever repo you configure above.

---

**Experimental** — No stability guarantees, no migration paths, breaking changes expected. This is a learning project first and a tool second.
