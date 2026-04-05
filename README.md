# G-Dashboard

> **This project is experimental and under active development.**
> Features, data formats, and APIs may change at any time without notice. Use at your own risk — do not rely on it for production financial workflows yet.

A full-stack desktop application for financial management, designed for Italian companies. G-Dashboard helps track banking transactions, build cash flow projections, and manage budgets — all from a single interface backed by Excel files you already use.

## Features

- **Transaction management** — Import, create, edit, and categorize banking transactions with automatic category suggestions based on frequency analysis
- **Cash flow tracking** — Visualize inflows and outflows by category and month, with automatic sync from transaction data to cash flow sheets
- **Budget planning** — Create and compare multiple budget scenarios (pessimistic, realistic, optimistic) with cash flow projections
- **Analytics** — Year-over-year and quarter-over-quarter dashboards for both cash flow and budget data
- **Activity audit log** — Full traceability of every change with filtering and search
- **Excel-native storage** — Reads and writes `.xlsx` files directly, preserving formulas and charts, so your data stays in a format you control
- **Auto-update** — Built-in update mechanism for seamless delivery of new builds

## Tech stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Electron (macOS, Apple Silicon) |
| Frontend | React 19, Vite 6, Tailwind CSS 3 |
| Backend | Express 4 (Node.js, ES modules) |
| Storage | Excel files (ExcelJS + xlsx-populate) and JSON |
| Tests | Node.js built-in test runner |

## Italian context

The app is built for Italian companies: month names use Italian abbreviations (GEN, FEB, MAR, ...), currency is EUR, and category naming follows Italian accounting conventions.

## About this repository

This repository contains both the **source code** and the **release builds** for auto-update distribution. Releases are published as GitHub Releases with macOS `.zip` archives.

---

**Experimental** — This is a personal/internal tool in early development. There are no stability guarantees, no migration paths between versions, and breaking changes are expected. Contributions and issues are welcome, but please keep the experimental nature in mind.