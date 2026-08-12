import XlsxPopulate from 'xlsx-populate';

const DATA_ROWS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20, 21, 22, 23, 24, 25, 30];
const FORMULA_ROWS = [16, 26, 31, 34, 36, 39];
const MONTH_COLS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]; // B..M
const COL_LETTER = { 2:'B', 3:'C', 4:'D', 5:'E', 6:'F', 7:'G', 8:'H', 9:'I', 10:'J', 11:'K', 12:'L', 13:'M' };

/**
 * Build a Cash Flow workbook structured enough for `syncCashFlow` to operate on.
 *
 * - One year sheet (named after `opts.year`).
 * - Data rows (4-15, 20-25, 30) initialized to 0 across columns B..M.
 * - Formula rows (16, 26, 31, 34) hold real formulas with cached value 0, so the
 *   sync-time `xmlSetCell` cache update can be verified to preserve `<f>`.
 * - Column O initialized to 0 on all relevant rows so annual-total writes have a cell.
 * - `opts.seedCells` (optional): map of cellRef → value written AFTER the zero
 *   init, so tests can plant stale nonzero values the sync's zeroing pass must clear.
 */
export async function buildCashFlowFixture(filePath, opts = {}) {
  const year = String(opts.year || '2026');

  const wb = await XlsxPopulate.fromBlankAsync();
  const ws = wb.sheet(0).name(year);

  // Labels in column A (cosmetic; the sync code does not read these)
  ws.cell('A1').value(`Cash Flow ${year}`);
  ws.cell('A16').value('TOTALE COSTI');
  ws.cell('A26').value('TOTALE RICAVI');
  ws.cell('A31').value('TOTALE FINANZIAMENTI');
  ws.cell('A34').value('MARGINE');
  ws.cell('A36').value('SALDO');

  // Data rows: zero across B..M and O
  for (const r of DATA_ROWS) {
    for (const c of MONTH_COLS) {
      ws.cell(`${COL_LETTER[c]}${r}`).value(0);
    }
    ws.cell(`O${r}`).value(0);
  }

  // Formula rows: real formulas + cached 0
  for (const c of MONTH_COLS) {
    const letter = COL_LETTER[c];
    ws.cell(`${letter}16`).formula(`SUM(${letter}4:${letter}15)`);
    ws.cell(`${letter}26`).formula(`SUM(${letter}20:${letter}25)`);
    ws.cell(`${letter}31`).formula(`SUM(${letter}30)`);
    ws.cell(`${letter}34`).formula(`${letter}26-${letter}16+${letter}31`);
    ws.cell(`${letter}36`).value(0);
    ws.cell(`${letter}39`).value(0);
  }
  for (const r of FORMULA_ROWS) {
    ws.cell(`O${r}`).value(0);
  }

  // Stale seeds (opt-in): overwrite selected cells with nonzero values
  for (const [ref, value] of Object.entries(opts.seedCells || {})) {
    ws.cell(ref).value(value);
  }

  await wb.toFileAsync(filePath);
}
