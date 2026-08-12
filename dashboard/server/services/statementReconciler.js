// @ts-check
/**
 * Reconcile a parsed bank statement against the app's transactions for a month.
 * Pure logic — no I/O — so it is unit-tested directly.
 *
 * Strategy: each statement line is matched to at most one app transaction with
 * the same direction and amount (to the cent). When several app rows share an
 * amount/direction (e.g. two equal salary payments on the same day), the row
 * whose date and name best fit the statement line wins, and is then consumed so
 * the next colliding line takes a different row. The result is a two-way report:
 *   - matched:  statement line ↔ app row (confidence: 'confident' | 'review')
 *   - missing:  statement line with no app row (e.g. a bank fee not yet entered)
 *   - extra:    app row not present on the statement
 *   - balance:  statement opening/closing vs the app's month-end balance
 *
 * @typedef {import('./bankStatementParser.js').StatementLine} StatementLine
 * @typedef {import('./bankStatementParser.js').ParsedStatement} ParsedStatement
 */

function normalizeTokens(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((t) => t.length >= 3);
}

/** Fraction of the app name's significant tokens that appear in the statement text. */
function nameScore(description, name) {
  const nameTokens = normalizeTokens(name);
  if (nameTokens.length === 0) return 0;
  const descTokens = new Set(normalizeTokens(description));
  let hits = 0;
  for (const t of nameTokens) if (descTokens.has(t)) hits++;
  return hits / nameTokens.length;
}

function dayDiff(isoA, isoB) {
  if (!isoA || !isoB) return Infinity;
  const a = Date.parse(isoA);
  const b = Date.parse(isoB);
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.abs(a - b) / 86400000;
}

function isDateMatch(line, entry) {
  if (line.date === entry.date) return true;
  if (line.valueDate && line.valueDate === entry.date) return true;
  return dayDiff(line.date, entry.date) <= 4;
}

function scorePair(line, entry) {
  let score = 0;
  if (line.date === entry.date) score += 100;
  else if (line.valueDate && line.valueDate === entry.date) score += 80;
  else {
    const d = dayDiff(line.date, entry.date);
    if (d <= 4) score += 40 - d * 5;
  }
  score += nameScore(line.description, entry.name) * 50;
  return score;
}

const AMOUNT_TOLERANCE = 0.005;

function appEntryFromTransaction(tx) {
  const inflow = Number(tx.inflow) || 0;
  const outflow = Number(tx.outflow) || 0;
  const direction = inflow > 0 ? 'inflow' : 'outflow';
  return {
    row: tx.row,
    date: tx.date,
    name: tx.transaction || '',
    amount: inflow > 0 ? inflow : outflow,
    direction,
    consumed: false,
  };
}

function lineSummary(line) {
  return {
    date: line.date,
    valueDate: line.valueDate,
    type: line.type,
    reference: line.reference,
    communication: line.communication,
    amount: line.amount,
    direction: line.direction,
  };
}

/**
 * @param {ParsedStatement} statement
 * @param {Array<{ row: number, date: string, transaction?: string, inflow?: number|null, outflow?: number|null }>} transactions
 * @param {{ appClosingBalance?: number | null }} [opts]
 */
export function reconcileStatement(statement, transactions, { appClosingBalance = null } = {}) {
  const entries = transactions.map(appEntryFromTransaction);

  const matched = [];
  const missing = [];

  for (const line of statement.lines) {
    const candidates = entries.filter(
      (e) => !e.consumed && e.direction === line.direction && Math.abs(e.amount - line.amount) < AMOUNT_TOLERANCE,
    );
    if (candidates.length === 0) {
      missing.push(lineSummary(line));
      continue;
    }
    const best = candidates
      .map((e) => ({ e, score: scorePair(line, e) }))
      .sort((a, b) => b.score - a.score)[0];
    best.e.consumed = true;
    matched.push({
      ...lineSummary(line),
      confidence: isDateMatch(line, best.e) ? 'confident' : 'review',
      app: { row: best.e.row, date: best.e.date, name: best.e.name },
    });
  }

  const extra = entries
    .filter((e) => !e.consumed)
    .map((e) => ({ row: e.row, date: e.date, name: e.name, amount: e.amount, direction: e.direction }));

  const balance = {
    statementOpening: statement.openingBalance,
    statementClosing: statement.closingBalance,
    appClosing: appClosingBalance,
    matches:
      appClosingBalance != null &&
      statement.closingBalance != null &&
      Math.abs(appClosingBalance - statement.closingBalance) < AMOUNT_TOLERANCE,
  };

  return {
    iban: statement.iban,
    period: statement.period,
    matched,
    missing,
    extra,
    balance,
    counts: {
      statementLines: statement.lines.length,
      matched: matched.length,
      confident: matched.filter((m) => m.confidence === 'confident').length,
      review: matched.filter((m) => m.confidence === 'review').length,
      missing: missing.length,
      extra: extra.length,
    },
  };
}
