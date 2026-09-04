// @ts-check
import { getDb } from './db.js';
import { readCfBudgetMap } from './cfBudgetCategoryMap.js';
import { fromCents } from './money.js';

/**
 * Store-backed reads (ADR-0001, T7).
 *
 * Returns Transactions in exactly the shape `GET /transactions/:year/:month`
 * returns today — the T6 equivalence harness is what holds that claim up.
 *
 * Balance is **computed**, never read from a column: one Year-long running
 * total seeded by GEN's opening balance and ordered by (month_idx, excel_row),
 * per ADR §5. That subsumes the cross-Month carry-forward loop in `banking.js`.
 */

/** @typedef {'json' | 'sqlite'} StoreMode */

/**
 * Which path serves reads and owns writes. Read once, at module load: a flag
 * that can change between two requests in the same session is a source of
 * irreproducible bugs, and nothing about this decision is per-request.
 *
 * Defaults to `sqlite` since Checkpoint C. The flip waited for T15: until the
 * JSON export existed, a store that owned writes left the six `.gl-data` files
 * stale, so `GL_STORE=json` would not have been a rollback but data loss.
 * Setting it to `json` is the rollback for the length of the soak; T18 removes
 * both the flag and the path behind it.
 * @type {StoreMode}
 */
const STORE_MODE = process.env.GL_STORE === 'json' ? 'json' : 'sqlite';

/** @returns {StoreMode} */
export function getStoreMode() {
  return STORE_MODE;
}

/** True when routes should read from the store rather than the workbooks. */
export function useStore() {
  return STORE_MODE === 'sqlite';
}

const MONTH_QUERY = `
  SELECT
    t.id, t.excel_row, t.date, t.type, t.transaction_name, t.notes, t.iban,
    t.inflow_cents, t.outflow_cents, t.cash_flow, t.comments, t.updated_at,
    a.transaction_id AS a_id, a.storage_mode, a.relative_path, a.absolute_path,
    a.file_name, a.original_file_name, a.mime_type, a.size,
    a.linked_at, a.updated_at AS a_updated_at, a.status, a.last_verified_at,
    c.checked, c.checked_at, c.source AS check_source,
    l.invoice_number, l.invoice_year,
    o.category AS override_category, o.budget_row AS override_row
  FROM transactions t
  LEFT JOIN transaction_attachments   a ON a.transaction_id = t.id
  LEFT JOIN transaction_checks        c ON c.transaction_id = t.id
  LEFT JOIN transaction_invoice_links l ON l.transaction_id = t.id
  LEFT JOIN budget_overrides          o ON o.transaction_id = t.id
  WHERE t.year = ? AND t.month = ? AND t.excel_row IS NOT NULL
  ORDER BY t.excel_row
`;

// budget_entries is NOT joined above: several entries may link to one
// transaction, which would multiply the result rows. `transactionBudgetMonths`
// resolves that by letting the last entry in file order win, and insertion
// order is file order, so ordering by rowid reproduces it exactly.
const BUDGET_MONTH_QUERY = `
  SELECT transaction_id, competency_month, date
  FROM budget_entries
  WHERE year = ? AND transaction_id IS NOT NULL
  ORDER BY rowid
`;

// A row with no excel_row has not been placed on a sheet yet — a transient
// state inside a write. It is neither listed nor allowed to shift the running
// Balance of the rows that are placed.
const BALANCE_QUERY = `
  SELECT id, balance_cents FROM (
    SELECT t.id, t.month,
      (SELECT COALESCE(opening_cents, 0) FROM year_meta WHERE year = t.year)
        + SUM(t.inflow_cents - t.outflow_cents)
            OVER (ORDER BY t.month_idx, t.excel_row ROWS UNBOUNDED PRECEDING) AS balance_cents
    FROM transactions t
    WHERE t.year = ? AND t.excel_row IS NOT NULL
  ) WHERE month = ?
`;

/**
 * Rebuild an AttachmentRecord from its stored columns.
 *
 * Only fields the source record carried are emitted: an absent
 * `originalFileName` must stay absent rather than become an explicit null, or
 * the response shape changes even where the data has not.
 */
function attachmentFromRow(row) {
  const record = { storageMode: row.storage_mode };
  if (row.storage_mode === 'external') record.absolutePath = row.absolute_path;
  else record.relativePath = row.relative_path;
  const optional = [
    ['fileName', row.file_name],
    ['originalFileName', row.original_file_name],
    ['mimeType', row.mime_type],
    ['size', row.size],
    ['linkedAt', row.linked_at],
    ['updatedAt', row.a_updated_at],
    ['status', row.status],
    ['lastVerifiedAt', row.last_verified_at],
  ];
  for (const [key, value] of optional) {
    if (value !== null && value !== undefined) record[key] = value;
  }
  return record;
}

/**
 * Cents back to the shape the read path returns: `null` for an empty cell, a
 * Number otherwise. Safe because no row in 2022–2026 holds a numeric zero —
 * an amount is either a number or an empty cell.
 */
function amountFromCents(cents) {
  return cents === 0 ? null : fromCents(cents);
}

// One grouped scan replaces opening and parsing twelve workbooks per request.
// Grouping by (month, override, category) collapses a Year to a few dozen rows,
// which is what makes resolving the Mapping in JS cheap — it lives in
// `cf_budget_map`, keyed by CF category rather than by row, so it is read once
// and applied here rather than joined per Transaction.
const BUDGET_SUMMARY_QUERY = `
  SELECT t.month_idx, o.budget_row AS override_row, t.cash_flow,
         SUM(t.inflow_cents + t.outflow_cents) AS cents
  FROM transactions t
  LEFT JOIN budget_overrides o ON o.transaction_id = t.id
  WHERE t.year = ? AND t.excel_row IS NOT NULL
  GROUP BY t.month_idx, o.budget_row, t.cash_flow
`;

/**
 * Budget row → twelve monthly totals in integer cents, for one Year.
 *
 * Reproduces the resolver's precedence exactly: a per-Transaction Override
 * wins, otherwise the global CF→Budget Mapping, otherwise the Transaction does
 * not contribute. Inflow and outflow are *added*, matching the endpoint today.
 *
 * @param {string} year
 * @returns {Promise<Record<number, number[]>>}
 */
export async function budgetSummaryCents(year) {
  const cfMap = await readCfBudgetMap().catch(() => ({}));
  const rows = /** @type {any[]} */ (getDb().prepare(BUDGET_SUMMARY_QUERY).all(String(year)));

  /** @type {Record<number, number[]>} */
  const summary = {};
  for (const row of rows) {
    const mapped = row.cash_flow ? cfMap[row.cash_flow] : null;
    const budgetRow = row.override_row != null
      ? row.override_row
      : (mapped && mapped.budgetRow != null ? mapped.budgetRow : null);
    if (budgetRow == null) continue;
    if (!summary[budgetRow]) summary[budgetRow] = new Array(12).fill(0);
    summary[budgetRow][row.month_idx] += row.cents;
  }
  return summary;
}

// Cash Flow sync and Budget CF sync need the same primitive: per Month, per CF
// category, cents — where a C- category sums outflow and an R- category sums
// inflow. substr rather than LIKE, because LIKE is case-insensitive in SQLite
// and the JS it replaces uses a case-sensitive startsWith.
const CATEGORY_CENTS_QUERY = `
  SELECT month, cash_flow, COUNT(*) AS row_count,
    SUM(CASE
          WHEN substr(cash_flow, 1, 2) = 'C-' THEN outflow_cents
          WHEN substr(cash_flow, 1, 2) = 'R-' THEN inflow_cents
          ELSE 0
        END) AS cents
  FROM transactions
  WHERE year = ? AND excel_row IS NOT NULL
  GROUP BY month, cash_flow
`;

/**
 * Per-Month CF category totals for one Year, in integer cents.
 *
 * `rows` counts every Transaction in the Month, including uncategorised ones:
 * the Budget CF sync uses "did this Month have any actuals at all?" to decide
 * totals-row styling, which is not the same question as "did it have
 * categorised actuals".
 *
 * @param {string} year
 * @returns {Record<string, { rows: number, categories: Record<string, number> }>}
 */
export function monthCategoryCents(year) {
  const rows = /** @type {any[]} */ (getDb().prepare(CATEGORY_CENTS_QUERY).all(String(year)));
  /** @type {Record<string, { rows: number, categories: Record<string, number> }>} */
  const byMonth = {};
  for (const row of rows) {
    if (!byMonth[row.month]) byMonth[row.month] = { rows: 0, categories: {} };
    byMonth[row.month].rows += row.row_count;
    if (!row.cash_flow) continue;
    byMonth[row.month].categories[row.cash_flow] =
      (byMonth[row.month].categories[row.cash_flow] || 0) + row.cents;
  }
  return byMonth;
}

// Elements detail needs per-Recipient actuals: cost, revenue, and how often each
// CF category was used, so the most-frequent one can be suggested. Grouping by
// (name, category) lets one scan answer all three.
//
// `first_seen` reproduces the tie-break of the JS loop it replaces: that walked
// Months in calendar order and rows in sheet order, inserting each category on
// first sight, and its "most frequent" pick used a strict `>` — so on a tie the
// earliest-seen category won. `instr` over the Month names gives a monotonic
// calendar ordinal (GEN=1, FEB=4, ...) without a twelve-branch CASE.
const ELEMENT_TOTALS_QUERY = `
  SELECT transaction_name, cash_flow,
    COUNT(*) AS freq,
    COALESCE(SUM(outflow_cents), 0) AS outflow_cents,
    COALESCE(SUM(inflow_cents), 0) AS inflow_cents,
    MIN(instr('GENFEBMARAPRMAGGIULUGAGOSETOTTNOVDIC', month) * 100000 + excel_row) AS first_seen
  FROM transactions
  WHERE year = ? AND excel_row IS NOT NULL AND transaction_name IS NOT NULL
  GROUP BY transaction_name, cash_flow
  ORDER BY first_seen
`;

/**
 * Per-Recipient actuals for one Year, in integer cents.
 *
 * @param {string} year
 * @returns {Record<string, { cost: number, revenue: number, catFreq: Record<string, number> }>}
 */
export function elementTotalsCents(year) {
  const rows = /** @type {any[]} */ (getDb().prepare(ELEMENT_TOTALS_QUERY).all(String(year)));
  /** @type {Record<string, { cost: number, revenue: number, catFreq: Record<string, number> }>} */
  const byName = {};
  for (const row of rows) {
    if (!byName[row.transaction_name]) byName[row.transaction_name] = { cost: 0, revenue: 0, catFreq: {} };
    const entry = byName[row.transaction_name];
    entry.cost += row.outflow_cents;
    entry.revenue += row.inflow_cents;
    // An uncategorised Transaction still counts toward cost and revenue, but
    // must not vote for a category — the JS `if (tx.cashFlow)` guard.
    if (row.cash_flow) entry.catFreq[row.cash_flow] = (entry.catFreq[row.cash_flow] || 0) + row.freq;
  }
  return byName;
}

/**
 * Resolve a sheet position to a stable Transaction id.
 *
 * Returns `null` when nothing occupies that row, so a route holding a stale row
 * number can 404 instead of acting on whatever moved into its place.
 *
 * @param {string} year
 * @param {string} month
 * @param {number} excelRow
 * @returns {number | null}
 */
export function resolveId(year, month, excelRow) {
  const row = /** @type {any} */ (getDb()
    .prepare('SELECT id FROM transactions WHERE year = ? AND month = ? AND excel_row = ?')
    .get(String(year), month, excelRow));
  return row ? Number(row.id) : null;
}

/**
 * One Transaction by id, in the shape the route returns. `null` if it is gone.
 * @param {number} id
 */
export async function getById(id) {
  const located = /** @type {any} */ (getDb()
    .prepare('SELECT year, month FROM transactions WHERE id = ?')
    .get(id));
  if (!located) return null;
  const rows = await listByMonth(located.year, located.month);
  return rows.find((tx) => tx.id === id) ?? null;
}

/**
 * Every Transaction of one (Year, Month), in sheet order, with the metadata
 * `attachTransactionMetadata` attaches today.
 *
 * @param {string} year
 * @param {string} month
 * @returns {Promise<any[]>}
 */
export async function listByMonth(year, month) {
  // The global CF→Budget Mapping lives in `cf_budget_map`, keyed by CF category
  // rather than by row, so it is read once here rather than joined per row.
  const cfMap = await readCfBudgetMap().catch(() => ({}));
  const db = getDb();
  const y = String(year);
  const rowsOf = (sql, ...params) => /** @type {any[]} */ (db.prepare(sql).all(...params));

  const balances = new Map(
    rowsOf(BALANCE_QUERY, y, month).map((r) => [r.id, r.balance_cents])
  );
  const budgetMonths = new Map();
  for (const entry of rowsOf(BUDGET_MONTH_QUERY, y)) {
    budgetMonths.set(
      entry.transaction_id,
      entry.competency_month != null
        ? entry.competency_month
        : parseInt(entry.date.slice(5, 7), 10) - 1,
    );
  }

  return rowsOf(MONTH_QUERY, y, month).map((r) => {
    /** @type {Record<string, any>} */
    const tx = {
      // Additive: the client ignores it today, and it is what lets the client
      // move to id-based URLs later as an independent change.
      id: r.id,
      row: r.excel_row,
      date: r.date,
      type: r.type,
      transaction: r.transaction_name,
      notes: r.notes,
      iban: r.iban,
      inflow: amountFromCents(r.inflow_cents),
      outflow: amountFromCents(r.outflow_cents),
      balance: fromCents(balances.get(r.id) ?? 0),
      cashFlow: r.cash_flow,
      comments: r.comments,
    };

    // Override beats the global Mapping — the precedence the resolver owns.
    const mapped = r.cash_flow ? cfMap[r.cash_flow] : null;
    if (r.override_row != null) {
      tx.budgetCategory = r.override_category;
      tx.budgetRow = r.override_row;
    } else if (mapped && mapped.budgetRow != null) {
      tx.budgetCategory = mapped.budgetCategory;
      tx.budgetRow = mapped.budgetRow;
    }

    if (budgetMonths.has(r.id)) tx.budgetMonth = budgetMonths.get(r.id);
    if (r.updated_at) tx.updatedAt = r.updated_at;
    if (r.a_id != null) tx.attachment = attachmentFromRow(r);
    if (r.checked) {
      tx.checked = true;
      tx.checkedAt = r.checked_at;
      tx.checkSource = r.check_source;
    }
    if (r.invoice_number != null) {
      tx.invoiceNumber = r.invoice_number;
      tx.invoiceYear = r.invoice_year || null;
    }
    return tx;
  });
}

/**
 * `{MONTH}-{ROW}` for one Transaction id, or null if it is unplaced or gone.
 * The sidecar services key their return values this way, so store-backed reads
 * can hand callers the exact shape the JSON files produced.
 *
 * @param {number} id
 */
export function rowKeyForId(id) {
  const row = /** @type {any} */ (getDb()
    .prepare('SELECT month, excel_row FROM transactions WHERE id = ? AND excel_row IS NOT NULL')
    .get(id));
  return row ? `${row.month}-${row.excel_row}` : null;
}

/**
 * Every placed Transaction of a Year as id → `{MONTH}-{ROW}`.
 * @param {string} year
 */
export function rowKeysForYear(year) {
  const rows = /** @type {any[]} */ (getDb().prepare(
    'SELECT id, month, excel_row FROM transactions WHERE year = ? AND excel_row IS NOT NULL'
  ).all(String(year)));
  return new Map(rows.map((r) => [r.id, `${r.month}-${r.excel_row}`]));
}

/**
 * Resolve a sheet position to an id, or throw the error a route already maps
 * to 404. Used by the sidecar writes, which must never land on "some row".
 *
 * @param {string} year
 * @param {string} month
 * @param {number} row
 */
export function requireId(year, month, row) {
  const id = resolveId(year, month, row);
  if (id == null) {
    const err = /** @type {Error & { code: string }} */ (new Error('Transaction row not found'));
    err.code = 'TRANSACTION_NOT_FOUND';
    throw err;
  }
  return id;
}
