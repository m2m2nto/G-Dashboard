# Gulliver Lux Dashboard

Local dashboard for reviewing and maintaining the Gulliver Lux banking transactions and cash flow workbooks.

## Overview

- Backend (Node/Express) reads and writes to the Excel files in the repo root.
- Frontend (Vite/React) provides the UI for transactions, cash flow, and elements.
- Cash flow sync writes directly into the Cash Flow workbook while preserving Excel structure.

## Stack

- Node.js (ESM)
- Express 4.x
- ExcelJS 4.x, XlsxPopulate 1.x, JSZip 3.x
- React 19.x + Vite 6.x + Tailwind 3.x

## Run

From `dashboard/`:

```
npm install
npm run dev
```

- Client: http://localhost:5173
- Server: http://localhost:3001

## Notes

- The server expects `Banking transactions - Gulliver Lux 2026.xlsx` and `Cash Flow Gulliver Lux.xlsx` in the repo root.
- Cash flow sync targets the worksheet for the requested year (defaults to the latest numeric year in the workbook).

## Changelog (recent)

- Added JSZip dependency for server runtime.
- Cash flow sync now resolves the correct sheet by year.
- Added transaction payload validation and tests.
