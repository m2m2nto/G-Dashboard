// @ts-check
/**
 * Parser for BGL BNP Paribas "Extrait de compte" PDF statements.
 *
 * Two layers:
 *   - extractTokens(buffer): thin pdfjs adapter → positioned text tokens.
 *   - parseStatementFromTokens(tokens): PURE column/block reconstruction → a
 *     structured statement. Unit-tested directly with hand-crafted tokens so we
 *     never have to ship a real (private) bank statement into the test suite.
 *
 * The layout is fixed (single bank/template). Column x-boundaries, observed from
 * the real PDF, are the named constants below.
 *
 * @typedef {{ x: number, y: number, page: number, str: string }} Token
 * @typedef {{
 *   date: string,            // ISO yyyy-mm-dd (operation date)
 *   valueDate: string | null,
 *   type: string,            // e.g. "VIREMENT SEPA"
 *   reference: string,       // bank reference, e.g. "LE9004"
 *   communication: string,   // free-text description (counterparty, memo)
 *   description: string,     // type + communication, for matching
 *   amount: number,          // absolute EUR value (always positive)
 *   direction: 'inflow' | 'outflow',
 * }} StatementLine
 * @typedef {{
 *   iban: string | null,
 *   period: { from: string | null, to: string | null },
 *   openingBalance: number | null,
 *   closingBalance: number | null,
 *   lines: StatementLine[],
 * }} ParsedStatement
 */

// Column boundaries (PDF user-space x), from the real statement layout.
const X_DATE_MAX = 90; // operation date column: x < 90
const X_NATURE_LABEL_MAX = 200; // label sub-column: 90 <= x < 200 (type, "Communication", "Référence"…)
const X_MONTANT_MIN = 445; // amount + sign: 445 <= x < 502
const X_VALUEDATE_MIN = 502; // value date: x >= 502

const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/**
 * Parse a European-formatted amount ("123.456,78", "16,00") to a Number.
 * Thousands separator is '.', decimal separator is ','.
 * @param {string} raw
 * @returns {number | null}
 */
export function parseEuroAmount(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).trim().replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** dd/mm/yyyy → yyyy-mm-dd, or null. */
function toIsoDate(raw) {
  const m = DATE_RE.exec(String(raw).trim());
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Cluster tokens of a single page into visual lines (rows) and order them
 * top-to-bottom. Rows can be split by ~1px between an amount and its label, so
 * tokens within Y_TOLERANCE of an open cluster join it.
 * @param {Token[]} tokens
 * @returns {Token[][]}
 */
function buildLines(tokens) {
  const Y_TOLERANCE = 3;
  const byPage = new Map();
  for (const t of tokens) {
    if (!t.str || !t.str.trim()) continue;
    if (!byPage.has(t.page)) byPage.set(t.page, []);
    byPage.get(t.page).push(t);
  }
  const lines = [];
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const items = byPage.get(page).slice().sort((a, b) => b.y - a.y); // top-down
    let cluster = null;
    let clusterY = null;
    for (const it of items) {
      if (cluster && Math.abs(clusterY - it.y) <= Y_TOLERANCE) {
        cluster.push(it);
      } else {
        if (cluster) lines.push(cluster);
        cluster = [it];
        clusterY = it.y;
      }
    }
    if (cluster) lines.push(cluster);
  }
  // Within each line, order left-to-right.
  for (const line of lines) line.sort((a, b) => a.x - b.x);
  return lines;
}

const colText = (line, min, max) =>
  line
    .filter((t) => t.x >= min && t.x < max)
    .map((t) => t.str.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

const lineText = (line) => line.map((t) => t.str.trim()).filter(Boolean).join(' ');

/**
 * Extract IBAN and statement period from the header tokens.
 * @param {Token[]} tokens
 */
function extractMeta(tokens) {
  let iban = null;
  let from = null;
  let to = null;
  for (const t of tokens) {
    const s = t.str;
    if (iban == null) {
      const m = /IBAN\s+([A-Z]{2}[\dA-Z ]{10,40}?)\s*\(/.exec(s);
      if (m) iban = m[1].replace(/\s+/g, '');
    }
    if (from == null) {
      const m = /\bdu\s+(\d{2}\/\d{2}\/\d{4})/.exec(s);
      if (m) from = toIsoDate(m[1]);
    }
    if (to == null) {
      const m = /\bau\s+(\d{2}\/\d{2}\/\d{4})/.exec(s);
      if (m) to = toIsoDate(m[1]);
    }
  }
  return { iban, period: { from, to } };
}

/**
 * Pure reconstruction of a statement from positioned tokens.
 * @param {Token[]} tokens
 * @returns {ParsedStatement}
 */
export function parseStatementFromTokens(tokens) {
  const meta = extractMeta(tokens);
  const lines = buildLines(tokens);

  /** @type {ParsedStatement} */
  const out = {
    iban: meta.iban,
    period: meta.period,
    openingBalance: null,
    closingBalance: null,
    lines: [],
  };

  /** @type {(StatementLine & { _communicationLines: string[], _field: string | null }) | null} */
  let current = null;

  const finalize = () => {
    if (!current) return;
    current.communication = current._communicationLines.join(' ').replace(/\s+/g, ' ').trim();
    current.description = `${current.type} ${current.communication}`.replace(/\s+/g, ' ').trim();
    delete current._communicationLines;
    delete current._field;
    out.lines.push(current);
    current = null;
  };

  for (const line of lines) {
    const whole = lineText(line);
    if (/Nature opération/i.test(whole)) continue; // page header row

    const montantText = colText(line, X_MONTANT_MIN, X_VALUEDATE_MIN);
    const amountMatch = /([\d.]+,\d{2})/.exec(montantText);
    const signMatch = /([+\-])/.exec(montantText);

    // Opening / closing balance rows.
    if (/Solde\s+créditeur/i.test(whole)) {
      const bal = amountMatch ? parseEuroAmount(amountMatch[1]) : null;
      if (bal != null) {
        if (out.openingBalance == null && out.lines.length === 0) out.openingBalance = bal;
        else out.closingBalance = bal;
      }
      finalize();
      continue;
    }

    const dateText = colText(line, 0, X_DATE_MAX);
    const opDate = toIsoDate(dateText);
    const amount = amountMatch ? parseEuroAmount(amountMatch[1]) : null;

    if (opDate && amount != null) {
      // New transaction row.
      finalize();
      const valueDate = toIsoDate(colText(line, X_VALUEDATE_MIN, Infinity));
      const type = colText(line, X_DATE_MAX, X_NATURE_LABEL_MAX);
      current = {
        date: opDate,
        valueDate,
        type,
        reference: '',
        communication: '',
        description: '',
        amount,
        direction: signMatch && signMatch[1] === '+' ? 'inflow' : 'outflow',
        _communicationLines: [],
        _field: null,
      };
      continue;
    }

    if (!current) continue; // pre-table noise

    // Continuation row inside the current transaction block.
    const label = colText(line, X_DATE_MAX, X_NATURE_LABEL_MAX);
    const value = colText(line, X_NATURE_LABEL_MAX, X_MONTANT_MIN);
    if (/^Communication/i.test(label)) {
      current._field = 'comm';
      if (value) current._communicationLines.push(value);
    } else if (/^(Référence|Reference)/i.test(label)) {
      current.reference = value;
      current._field = null;
    } else if (label) {
      // Other labelled fields (Donneur d'ordre, Auprès de, …) — not needed for matching.
      current._field = null;
    } else if (value && current._field === 'comm') {
      current._communicationLines.push(value);
    }
  }
  finalize();

  return out;
}

/**
 * Extract positioned text tokens from a PDF buffer using pdfjs (loaded lazily so
 * the pure parser and its tests never pull in pdfjs).
 * @param {Buffer | Uint8Array} buffer
 * @returns {Promise<Token[]>}
 */
export async function extractTokens(buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdfjs rejects Node Buffer specifically; coerce to a plain Uint8Array.
  const data = new Uint8Array(buffer);
  const params = /** @type {any} */ ({ data, isEvalSupported: false, verbosity: 0 });
  const loadingTask = getDocument(params);
  const doc = await loadingTask.promise;
  /** @type {Token[]} */
  const tokens = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!('str' in item)) continue;
        tokens.push({ x: item.transform[4], y: item.transform[5], page: p, str: item.str });
      }
    }
  } finally {
    await loadingTask.destroy();
  }
  return tokens;
}

/**
 * Parse a BGL bank statement PDF buffer into a structured statement.
 * @param {Buffer | Uint8Array} buffer
 * @returns {Promise<ParsedStatement>}
 */
export async function parseBankStatement(buffer) {
  const tokens = await extractTokens(buffer);
  return parseStatementFromTokens(tokens);
}
