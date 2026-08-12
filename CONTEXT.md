# GL-Dashboard

Financial management context for Gulliver Lux: banking transactions, cash-flow projection, and budgeting against scenarios.

## Language

### Money & time

**EUR**:
The single currency. All amounts are stored as integer cents internally and rendered with `de-DE` locale (`Number.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })`).
_Avoid_: `€`, `eur`, "euros" in identifiers.

**Month**:
A calendar month identified by its Italian three-letter abbreviation: `GEN`, `FEB`, `MAR`, `APR`, `MAG`, `GIU`, `LUG`, `AGO`, `SET`, `OTT`, `NOV`, `DIC`.
_Avoid_: English abbreviations, full Italian names, month numbers, ISO `YYYY-MM`.

**Year**:
A four-digit Gregorian year identifying which Banking file applies. The Cash Flow file spans multiple years; the Budget file is per-year.

### Transactions & entities

**Transaction**:
A single banking movement recorded in the Banking file for a given Year and Month. Has a Date, a Recipient, a Direction, an Amount, optional Notes, an assigned Cash Flow Category, and zero or more Attachments.

**Recipient**:
The counterparty named on a Transaction — the person or entity money flows to or from. This is the canonical term for the field the UI also labels "Transaction" (the free-text name).
_Avoid_: "transaction name", "payee", "vendor", "customer" — all refer to the same thing.

**Element**:
A Recipient promoted to a first-class entity in the Cash Flow file, with an assigned Cash Flow Category and aggregated cost/revenue totals. Elements are deduplicated across all Transactions sharing the same Recipient string. Created automatically when a Recipient is first used, and editable in the Cash Flow → Recipients sub-tab.
_Avoid_: "vendor", "supplier", "actor".

**Direction**:
Whether a Transaction is a **cost** (money out) or a **revenue** (money in). Must agree with the prefix of its Cash Flow Category — this is enforced at the domain layer.
_Avoid_: "type", "sign", "debit/credit", "in/out".

**Attachment**:
A file (PDF, image, or Office document) linked to a Transaction. Stored on disk under `{year}/{recipient}/{date} - {recipient}.{ext}`. A Transaction can have multiple Attachments.

### Categories & mapping

**Cash Flow Category** (CF Category):
A taxonomy term assigned to each Transaction, used to aggregate the Cash Flow file. Always prefixed `C-` for costs or `R-` for revenues — the prefix encodes Direction. Examples: `C-Affitto`, `R-Vendite`.
_Avoid_: bare "Category" (ambiguous), "expense category".

**Budget Category**:
A separate taxonomy used by the Budget file, organised into Cost, Revenue, and Financing groups. Distinct from Cash Flow Category — a CF Category is mapped to a Budget Category through the **Mapping**.
_Avoid_: bare "Category" (ambiguous).

**Mapping**:
The global, persisted relationship from CF Category → Budget Category. Lives in `.gl-data/cf-budget-category-map.json`. The Budget Category for a Transaction is **derived** through this Mapping at read-time, never stored on the Transaction itself.

**Budget Category Override**:
A per-Transaction-row record that overrides the Mapping for a single Transaction. Lives in `.gl-data/transaction-budget-map-{year}.json`. The Override wins when both an Override and a Mapping apply. Used when a Transaction belongs to a different Budget Category than its CF Category would suggest (e.g. a one-off reclassification).
_Avoid_: "per-transaction mapping", "tx mapping" — the canonical term is **Override** to distinguish it from the global **Mapping**.

**Category Hint**:
A frequency-based suggestion for which CF Category a new Transaction belongs to, computed from past Recipient + Notes pairs. Shown inline in the Transaction Form.

### Cash flow & budget

**Cash Flow**:
The monthly aggregation view of all Transactions for a Year, broken out by CF Category × Month. Stored in the Cash Flow file. Contains computed rows (`Totale Costi`, `Totale Ricavi`, `Margine`, `Saldo`) that must never be overwritten by sync.
_Avoid_: "cashflow" (single word) in user-facing text — acceptable in code/identifiers.

**Saldo**:
The running balance — previous year's Saldo plus this year's Margine — computed per month in the Cash Flow file. The Italian term is canonical; do not translate.

**Margine**:
Per-month margin: `Totale Ricavi - Totale Costi`. Computed by formula in the Cash Flow file.
_Avoid_: "margin", "profit".

**Sync**:
The operation that reads every Banking file for a Year, aggregates Transactions by CF Category × Month, and writes the result into the Cash Flow file — preserving formula rows, charts, and `calcChain.xml`.
_Avoid_: "refresh", "rebuild".

**Drill**:
A read operation that returns the list of Transactions contributing to a single Cash Flow cell (one Month × one CF Category).
_Avoid_: "expand", "explode".

**Scenario**:
A named projection of the Budget for a Year. The three canonical Scenarios are `certo`, `possibile`, and `ottimistico`. Each Scenario has its own sheet in the Budget file.

**Budget Entry**:
A planned future cash movement (revenue or cost) belonging to a Scenario for a Year, used to drive the Cash Flow Projection. Stored in `.gl-data/budget-entries-{year}.json`. Distinct from Transactions, which are actuals.
_Avoid_: "budget item", "budget line".

**Projection**:
The forward-looking Cash Flow view that overlays Budget Entries from a chosen Scenario onto historical Transactions to estimate future Saldo.

### Files & storage

**Project**:
The bundle of Excel files + `.gl-data/` directory + `gl-project.json` manifest that the dashboard operates on. The user can switch between Projects via Settings.

**Manifest**:
`gl-project.json` at the Project root. Lists file paths (per-year Banking files, the Cash Flow file, the Budget file), Users, and project metadata. Manifest version 2 supports per-year Banking files.

**Banking file**:
Per-Year Excel workbook holding raw Transactions, one sheet per Month. Named `Banking transactions - Gulliver Lux {year}.xlsx` by default.

**Cash Flow file**:
Single Excel workbook spanning all Years, containing the per-Year Cash Flow sheets, summary sheets, and Elements registry. Named `Cash Flow Gulliver Lux.xlsx` by default.

**Budget file**:
Per-Year Excel workbook holding the Budget Generale (consuntivo) sheet and one sheet per Scenario.

### People

**User**:
A named operator of the dashboard, tracked for audit purposes (`createdBy` / `updatedBy` on Transactions and the Activity Log). Lives in the Manifest. One User is **active** at a time.

**Activity Log**:
Append-only record of every mutating operation, sharded by day at `.gl-data/audit/{year}/{month}/{day}.jsonl`. Surfaced in the Activity section.
_Avoid_: "audit trail" in user-facing text; "audit" is acceptable in code/paths.

## Example dialogue

**Dev:** "When the user adds a new Transaction in March, where does the Recipient come from?"

**Domain expert:** "They type it into the form. If that Recipient already exists as an Element, the form uses the existing Element's CF Category as a hint. If not, a new Element gets created on the next read of the Cash Flow file, with no Category set yet."

**Dev:** "And the Budget Category?"

**Domain expert:** "Never stored on the Transaction. When something needs a Budget Category for a Transaction — like the Budget Summary view — it looks up the Transaction's CF Category in the Mapping. If there's no Mapping entry for that CF Category, the Transaction has no Budget Category as far as the system is concerned. The Mapping page is where the user keeps that table current."

**Dev:** "What if the user picks `R-Vendite` on a cost Transaction?"

**Domain expert:** "Blocked. Direction has to agree with the CF Category prefix — `R-` is revenue, `C-` is cost. The domain layer rejects the write."

## Flagged ambiguities

- **"Category" without a qualifier** — Always say **CF Category** or **Budget Category**. They are different taxonomies linked only by the Mapping.
- **"Transaction" as a form field** — In `TransactionForm`, the input named `transaction` holds the **Recipient**, not the whole Transaction. Prefer renaming or labelling it as Recipient in new code.
