# GL-Dashboard

A local dashboard for managing Gulliver Lux's banking transactions and cash flow reporting.

> **Note:** This is an experimental project, built as a personal productivity tool rather than a production-grade application.

## Context

Managing financial reporting through Excel spreadsheets gets complex fast — keeping data consistent across workbooks, avoiding manual errors, and maintaining a clear picture of cash flow all become harder as the volume of transactions grows.

The common (and arguably most reasonable) approach would be to move everything into a database. Instead, this project takes a different route: **the Excel spreadsheets remain the single source of truth**. The dashboard reads from and writes to them directly, adding a layer of validation and consistency on top without replacing the underlying format.

This choice is deliberate:

- **Retro-compatibility** — If the data ever needs to be shared with someone who doesn't use the dashboard, the Excel files are still perfectly usable on their own. No export step, no data migration.
- **Shared access via OneDrive/Teams** — The spreadsheets are already shared between parties through Microsoft's collaboration tools. Keeping Excel as the format means the existing sharing workflow stays untouched.
- **Independence** — The dashboard is a single-user tool. It helps me manage and report on the data without requiring anyone else to adopt it.

In short: the dashboard exists to make working with the spreadsheets faster and more reliable, not to replace them.

The app is also packaged as a **native macOS application** (via Electron), so it can run as a standalone desktop app without needing a browser or a terminal.

## Overview

- **Backend** (Node/Express) reads and writes Excel workbooks and persists auxiliary data as JSON in a `.gl-data/` directory.
- **Frontend** (Vite/React) provides six sections: Home, Transactions, Cash Flow, Budget, Analytics, and Activity.
- **Cash flow sync** writes directly into the Cash Flow workbook while preserving Excel structure (formulas, charts, table ranges).
- **Desktop app** packaged via Electron for standalone macOS use.

## Stack

- Node.js (ESM)
- Express 4.x
- ExcelJS 4.x, XlsxPopulate 1.x, JSZip 3.x
- React 19.x + Vite 6.x + Tailwind 3.x
- Electron + electron-builder (desktop packaging)

## Run

From `dashboard/`:

```bash
npm install
npm run dev
```

- Client: http://localhost:5173
- Server: http://localhost:3001

To build the desktop app:

```bash
bash scripts/build-electron.sh
```

## Notes

- Excel file paths are configured through the Settings panel (project manifest). On first launch, the app prompts you to select or create a project pointing to your workbooks.
- Cash flow sync targets the worksheet for the requested year (defaults to the latest numeric year in the workbook).
- Auxiliary data (budget entries, category mappings, audit log) is stored as JSON in `.gl-data/` inside the project folder.

## Changelog

See [HANDOFF.md](HANDOFF.md) for a session-by-session log of changes.
