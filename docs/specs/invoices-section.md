# Spec — Invoices Section (Accounts Receivable)

Status: **In progress** · Owner: Danilo · Date: 2026-07-01

Implementation progress:
- ✅ Slice 1 — read path (`invoiceLogic.js`, `invoices.js` reader, `GET /api/invoices/*`, client API, 13 unit tests).
- ✅ Slice 2 — section shell (sidebar item, `App.jsx` wiring, `InvoicesView` + `InvoiceTable` + KPIs).
- ✅ Slice 4 — write path (`addInvoice`/`updateInvoice`/`deleteInvoice` with Table-XML resize, routes, `InvoiceForm`, verified via isolated round-trip).
- ⬜ Slice 3 — self-service file registration (`detect.js` invoice type + Settings UI). 2026 file currently registered directly in the manifest.
- ◐ Slice 5 — polish: status/overdue badges, filters, next-number, audit entries done.

Track invoices **issued to customers** and their **payment status** (paid / outstanding /
overdue), backed by a per-year Excel report file, with full create/edit/delete inside the app.

---

## 1. Motivation

Today invoice tracking lives in a manually-maintained Excel workbook
(`.../Invoices and receipts/Credit/2026/2026 Invoice Report.xlsx`). It answers: which
invoices were issued, for how much, to whom, when they're due, whether they've been paid,
and which payment reminders were sent. There is no in-app view of receivables, no
outstanding/overdue KPIs, and every edit means opening Excel by hand.

This section brings that workbook into GL-Dashboard as a first-class, editable section —
matching how **Transactions** already wraps the banking workbook.

**Decisions locked in (2026-07-01):**
1. **Full CRUD** — the app reads *and writes* the report file (add / edit / delete invoices,
   mark paid, edit reminders).
2. **Multi-year** — one report file per year, registered in the project manifest and switched
   via the existing global year selector.
3. **Standalone** — no coupling to banking transactions, cash flow, or reconciliation. Pure
   receivables tracking, mirroring the source workbook's purpose.

---

## 2. Source data model (reverse-engineered)

File: `2026 Invoice Report.xlsx` → single sheet `Sheet1`, containing one Excel **Table**
(`Table1`, `ref A1:H18`, `totalsRowShown="0"`). Header row 1, data rows 2..N.

| Col | Header | Type | Notes |
|-----|--------|------|-------|
| A | `Invoice Number` | text | e.g. `G-001/2026`. Sequential per year: `G-{NNN}/{year}`. |
| B | `Recipient` | text | Customer name (free text; recurring values → autocomplete). |
| C | `Amount` | number (Currency style) | EUR, gross. Plain number cell (e.g. `517`, `4504.5`). |
| D | `Issue date` | date | When invoice was issued. |
| E | `Due date` | date | Payment deadline. In practice ≈ issue + 1 month. |
| F | `Payment date` | date · **nullable** | Empty ⇒ **unpaid**. Filled ⇒ **paid**. |
| G | `#1 Payment Reminder` | date · nullable | Date first reminder was sent. |
| H | `#2 Payment Reminder` | date · nullable | Date second reminder was sent. |

### 2.1 Data-quality hazard (must handle)

Date cells are **inconsistently stored** in the source file:
- Most are proper Excel **serial numbers** (`D2 = 46033`, styled as a date).
- Several are **text strings** typed `dd/mm/yyyy` (e.g. `"31/01/2026"`, `"20/05/2026"`,
  `"15/06/2026"`, `"30/06/2026"`).

**Reader** must accept *both* forms and normalise to a real date. **Writer** must always emit
proper serial-date numbers (and the Amount as a plain number) so that saving an invoice
progressively *heals* the file to a consistent format. This is the single biggest correctness
risk in the feature — it gets a dedicated regression test (§9).

### 2.2 Derived fields (computed, never stored)

Computed on read, in the service layer, relative to "today":

- **status**: `paid` if Payment date set; else `overdue` if Due date < today; else `open`.
- **daysOverdue**: `paid` → 0; else `max(0, today − dueDate)` in days.
- **daysToPay**: `paid` → `paymentDate − issueDate`; else `null`.
- **reminderCount**: number of reminder dates present (0/1/2).
- **isPaidLate**: `paid && paymentDate > dueDate`.

All amounts aggregated with the existing integer-cents helpers (`services/money.js`)
to avoid float drift.

---

## 3. Storage & configuration

### 3.1 Manifest (project.js) — new `invoiceFiles` map

Extend the v2 manifest with a per-year map, exactly parallel to `transactionFiles`:

```jsonc
{
  "version": 2,
  "cashFlowFile": "...",
  "budgetFile": "...",
  "transactionFiles": { "2026": "Banking transactions - Gulliver Lux 2026.xlsx" },
  "invoiceFiles":     { "2026": ".../2026 Invoice Report.xlsx" }   // NEW
}
```

`config.js` gains, mirroring the banking helpers:
- `getInvoiceFile(year)` — resolve absolute path for a year (with filename-pattern derivation
  for years not yet registered, same fallback logic as `getBankingFile`).
- `listInvoiceYears()` — manifest keys whose files exist on disk.
- `registerInvoiceFile(year, path)` — add/update a year → path entry.

### 3.2 File detection (detect.js)

Add an **invoice** file type to `detectFileType`: recognised by a single sheet containing a
table whose header row matches `Invoice Number`, `Recipient`, `Amount`, `Issue date`,
`Due date`, `Payment date` (reminders optional). Year parsed from the filename
(`(\d{4}) Invoice Report.xlsx`) with a fallback to the max issue-date year in the data.
`validateFileStructure` gains an `invoice` branch checking the header columns exist.

### 3.3 Settings UI

Add an **Invoice report** row to `client/src/components/settings/FileSection.jsx` (or the
transaction-files section if multi-year listing is preferred) using the existing `FilePicker`
+ `POST /api/settings/detect-files` / `check-file` flow. Optional for existing projects — the
section degrades gracefully when no file is configured (see §6, disabled-section behaviour).

---

## 4. Backend — service + route

### 4.1 Service — `server/services/invoices.js`

Read-write, following `banking.js` / `editTransaction.js` conventions:

- **Read** (ExcelJS, read-only): open workbook → iterate `Table1` data rows → map to invoice
  objects with `{ row, invoiceNumber, recipient, amount, issueDate, dueDate, paymentDate,
  reminder1, reminder2 }` + derived fields (§2.2). Dates normalised to ISO `yyyy-mm-dd`
  strings across the API boundary (both serial and `dd/mm/yyyy` text inputs handled).
- **Add** (xlsx-populate + JSZip): append a data row; **grow `Table1` ref** in
  `xl/tables/table1.xml` (`A1:H{N}` → `A1:H{N+1}`) and the sheet dimension; write Amount as a
  number and dates as serials with the date style. No formula/balance column exists, so —
  unlike banking — there is nothing to preserve there.
- **Update** (xlsx-populate): overwrite the 8 cells of the target row by row index.
- **Delete** (xlsx-populate + JSZip): shift rows up, **shrink `Table1` ref**, clear the freed
  trailing row.
- **Suggest next invoice number**: `G-{max(NNN)+1 padded to 3}/{year}`.
- Guard all writes with the existing `withLock` file-mutex + `atomicWrite` pattern.
- Emit audit-log entries (`services/audit.js`) on add/update/delete, consistent with
  transactions.

### 4.2 Route — `server/routes/invoices.js`, mounted at `/api/invoices`

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/years` | Years with a registered+present invoice file. |
| `GET`  | `/:year` | List invoices for the year (with derived fields + summary block). |
| `GET`  | `/:year/summary` | KPI aggregates only (issued, paid, outstanding, overdue counts/amounts). |
| `GET`  | `/:year/next-number` | Suggested next invoice number. |
| `POST` | `/:year` | Add an invoice. |
| `PUT`  | `/:year/:row` | Update the invoice at `row`. |
| `DELETE` | `/:year/:row` | Delete the invoice at `row`. |

Register in `server/index.js` (`app.use('/api/invoices', invoicesRouter)`).

### 4.3 Invoice attachments (shipped, post-spec addition)

A light **link-only** model (`server/services/invoiceAttachments.js`): the user picks a file
via a native macOS dialog and the app stores its absolute path — it never copies, moves,
renames, or deletes the file. Persisted in `.gl-data/invoice-attachments-{year}.json`, keyed
by **invoice number** (stable across the row shifts a delete causes), value
`{ path, fileName }`; reads annotate each record with `missing: !existsSync(path)`.

Routes (registered before the `/:year/:row` CRUD routes so `attachment` is never captured as
a row; `invoiceNumber` travels in the body because it contains a slash):

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/:year/attachment/select` | Native file dialog → link chosen path (cancel ⇒ `{ attachment: null }`). |
| `DELETE` | `/:year/attachment` | Unlink (never deletes the file). |
| `POST` | `/:year/attachment/open` | Open the linked file in the default app; 404 if unlinked or the file no longer exists. |

Lifecycle guarantees (covered by `server/tests/invoice-row-guards.test.js`):
`deleteInvoice` removes the deleted invoice's attachment link; `updateInvoice` re-keys the
link when the invoice number changes so it follows the invoice. Audit entries:
`invoice.attachment.link` / `invoice.attachment.unlink`.

### 4.4 Validation (pure, unit-testable)

- `invoiceNumber` required, unique within the year, shape `G-NNN/YYYY`.
- `recipient` required, non-empty.
- `amount` required, finite, > 0.
- `issueDate` required; `dueDate` required; `dueDate >= issueDate`.
- `paymentDate` / reminders optional; if present, must parse as dates.
- Reminder/payment dates should not precede issue date (warn, not block).

---

## 5. Frontend

### 5.1 Client API — `client/src/api.js`

Add `getInvoiceYears`, `getInvoices(year)`, `getInvoiceSummary(year)`,
`getNextInvoiceNumber(year)`, `addInvoice(year, payload)`, `updateInvoice(year, row, payload)`,
`deleteInvoice(year, row)`.

### 5.2 Navigation

Add a top-level item to `Sidebar.jsx` `NAV_ITEMS`:
`{ id: 'invoices', label: 'Invoices', icon: 'receipt_long' }` (placed after **Budget**).
Wire `section === 'invoices'` in `App.jsx`: state, `loadInvoices` loader (triggered when the
section is active and year changes), and the render branch. Add `'invoices'` to
`disabledSections` when the year has no invoice file.

### 5.3 Components (new)

- **`InvoicesView.jsx`** — section container. KPI cards + toolbar (search, status filter,
  “New invoice” button) + table.
- **`InvoiceTable.jsx`** — sortable table of columns from §2 plus **Status** and **Days
  overdue** badges. Row actions: edit, mark paid, delete. Follows `TransactionTable.jsx`
  styling and `ui.js` class constants. Overdue rows use `status-negative`, paid use
  `status-positive`, open/near-due use `status-warning`.
- **`InvoiceForm.jsx`** — add/edit dialog. Fields: invoice number (prefilled from
  `next-number`), recipient (`SearchableSelect` over existing recipients), amount, issue date,
  due date (default = issue + 1 month), payment date, reminder 1/2. Mirrors
  `TransactionForm.jsx`.
- Reuse `MetricCard`, `ConfirmDialog`, `SearchInput`, `SearchableSelect`, `YearSelector`.

### 5.4 KPIs (top of section)

Total issued (count + €), Paid (count + €), Outstanding (count + € = issued − paid),
Overdue (count + €). Optional secondary: average days-to-pay, count of invoices with
reminders sent. Currency formatted via the standard
`toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })`.

---

## 6. Edge cases & behaviours

- **No invoice file for the selected year** → section disabled in sidebar (existing
  `disabledSections` mechanism), tooltip “No invoice data for this year”.
- **Mixed/legacy date text** in source → read tolerantly; on any write of that row, rewrite as
  serial (progressive healing).
- **Empty Payment date** is the canonical “unpaid” signal — never write `0`/empty-string
  sentinels.
- **Concurrent writes** (multi-user) → `withLock` mutex, same as JSON persistence services.
- **Invoice number collisions** rejected at validation with a clear message.
- **File deleted/moved out from under the app** → 4xx with actionable message, section
  re-disables on next load.

---

## 7. Out of scope (explicit)

- Reconciliation against banking revenue transactions or cash flow (chosen standalone).
- Generating invoice PDFs / the individual `Invoice-NNN-*.xlsx` files (produced elsewhere).
- Emailing reminders (we record reminder *dates* only).
- VAT / net-vs-gross breakdown (source tracks a single gross Amount).
- Editing the workbook's styling, charts, or non-table content.

---

## 8. Implementation plan (vertical slices)

1. **Read path** → `invoices.js` reader + `GET /api/invoices/:year(/summary)` + client API.
   Verify: unit test parses the real file's 17 rows incl. the `dd/mm/yyyy` text dates.
2. **Section shell** → sidebar item, `App.jsx` wiring, `InvoicesView` + `InvoiceTable` +
   KPIs (read-only). Verify: table + KPIs render for 2026 in the running app.
3. **Config/detection** → `invoiceFiles` manifest, `config.js` helpers, `detect.js` type,
   settings UI. Verify: pick file in Settings → year appears in selector.
4. **Write path** → add/update/delete service (table-XML growth/shrink) + routes +
   `InvoiceForm`. Verify: round-trip test (add → read back → delete) leaves table ref +
   dimension correct; source formulas/charts untouched (none here, but assert file still opens).
5. **Polish** → status/overdue badges, filters, next-number suggestion, audit-log entries.

Each slice: `npm test` green before and after; typecheck clean.

---

## 9. Testing (mandatory per CLAUDE.md)

Node `node:test` + `node:assert/strict`, pure logic, no live server/Excel where avoidable:

- **Date normalisation**: serial `46033` and text `"31/01/2026"` both → `2026-01-31` (the
  data-quality regression test).
- **Status/derived fields**: paid, open, overdue; `daysOverdue`, `daysToPay`, `isPaidLate`
  against a fixed "today".
- **Validation**: missing fields, bad amount, `dueDate < issueDate`, duplicate invoice number.
- **Next-number**: `G-017/2026` present → suggests `G-018/2026`; empty file → `G-001/2026`.
- **Summary aggregation**: outstanding = issued − paid, in integer cents (no float drift).
- **Table XML ref math**: add grows `A1:H{N}`→`A1:H{N+1}`, delete shrinks it (against a
  temp-copied fixture workbook).

---

## 10. Resolved decisions

- **Sidebar position**: item placed **after Budget**.
- **Mark paid**: **always prompt** for the Payment date — never silently default to today.
- **CSV/PDF export**: not wanted — out of scope.
