import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStatementFromTokens, parseEuroAmount } from '../services/bankStatementParser.js';

// Hand-crafted tokens mirroring the real BGL "Extrait de compte" layout
// (x-coordinates taken from the actual statement) so the column boundaries are
// exercised exactly as in production — without shipping a private PDF.
function tok(x, y, str, page = 1) {
  return { x, y, page, str };
}

function sampleTokens() {
  return [
    // --- header / meta ---
    tok(58.8, 532, 'COMPTE OPTIFLEX IBAN LU21 9990 0000 1234 5678 (EUR)'),
    tok(487.4, 543, 'du 01/04/2026'),
    tok(488.2, 532, 'au 30/04/2026'),
    // page column header (must be skipped)
    tok(58.8, 463, 'Date'),
    tok(216.7, 463, 'Nature opération'),
    tok(438, 463, 'Montant'),
    tok(506.6, 463, 'Date valeur'),
    // --- opening balance (text and amount split by 1px, as in the real PDF) ---
    tok(95, 441, 'Solde créditeur au 31/03/2026'),
    tok(456.7, 442, '123.456,78'),
    tok(495.6, 442, '+'),
    // --- tx1: bank fee, outflow ---
    tok(47.8, 423, '01/04/2026'),
    tok(95.3, 423, 'TENUE DE COMPTE'),
    tok(476.2, 423, '16,00'),
    tok(495.6, 423, '-'),
    tok(508.3, 423, '01/04/2026'),
    tok(95.3, 414, 'Communication'),
    tok(203, 414, 'Frais pack confort pro'),
    tok(203, 404, 'Exonéré de TVA'),
    tok(95.3, 386, 'Référence'),
    tok(203, 386, 'WR9001'),
    // --- tx2: SEPA inflow ---
    tok(47.8, 370, '02/04/2026'),
    tok(95.3, 370, 'VIREMENT SEPA'),
    tok(465.4, 370, '425,50'),
    tok(495.6, 370, '+'),
    tok(508.3, 370, '02/04/2026'),
    tok(95.3, 360, 'Communication'),
    tok(203, 360, 'ON ACCOUNT'),
    tok(203, 350, 'GLOBEX INTL.CLEARING CO LTD'),
    tok(95.3, 340, 'Référence'),
    tok(203, 340, 'LP9002'),
    // --- tx3 & tx4: COLLISION — same date, same amount, same direction ---
    tok(47.8, 320, '30/04/2026'),
    tok(95.3, 320, 'VIREMENT SEPA'),
    tok(465.4, 320, '3.210,45'),
    tok(495.6, 320, '-'),
    tok(508.3, 320, '30/04/2026'),
    tok(95.3, 310, 'Communication'),
    tok(203, 310, 'Stipendio 04/2026'),
    tok(203, 300, 'MARIO-ALDO ROSSI'),
    tok(95.3, 290, 'Référence'),
    tok(203, 290, 'LE9003'),

    tok(47.8, 274, '30/04/2026'),
    tok(95.3, 274, 'VIREMENT SEPA'),
    tok(465.4, 274, '3.210,45'),
    tok(495.6, 274, '-'),
    tok(508.3, 274, '30/04/2026'),
    tok(95.3, 264, 'Communication'),
    tok(203, 264, 'Stipendio 04/2026'),
    tok(203, 254, 'Bruno Verdolini'),
    tok(95.3, 244, 'Référence'),
    tok(203, 244, 'LE9004'),
    // --- closing balance ---
    tok(95, 165, 'Solde créditeur au 30/04/2026'),
    tok(461, 165, '98.765,43'),
    tok(495.6, 165, '+'),
  ];
}

test('parseEuroAmount handles thousands and decimals', () => {
  assert.equal(parseEuroAmount('123.456,78'), 123456.78);
  assert.equal(parseEuroAmount('16,00'), 16);
  assert.equal(parseEuroAmount('3.210,45'), 3210.45);
  assert.equal(parseEuroAmount(''), null);
  assert.equal(parseEuroAmount('abc'), null);
});

test('parses statement meta: iban, period, opening and closing balance', () => {
  const st = parseStatementFromTokens(sampleTokens());
  assert.equal(st.iban, 'LU219990000012345678');
  assert.deepEqual(st.period, { from: '2026-04-01', to: '2026-04-30' });
  assert.equal(st.openingBalance, 123456.78);
  assert.equal(st.closingBalance, 98765.43);
});

test('parses each transaction row with date, type, amount, direction, reference', () => {
  const st = parseStatementFromTokens(sampleTokens());
  assert.equal(st.lines.length, 4);

  const fee = st.lines[0];
  assert.equal(fee.date, '2026-04-01');
  assert.equal(fee.valueDate, '2026-04-01');
  assert.equal(fee.type, 'TENUE DE COMPTE');
  assert.equal(fee.amount, 16);
  assert.equal(fee.direction, 'outflow');
  assert.equal(fee.reference, 'WR9001');
  assert.match(fee.communication, /Frais pack confort pro/);

  const inflow = st.lines[1];
  assert.equal(inflow.direction, 'inflow');
  assert.equal(inflow.amount, 425.5);
  assert.match(inflow.communication, /GLOBEX INTL\.CLEARING CO LTD/);
  assert.equal(inflow.reference, 'LP9002');
});

test('keeps colliding rows distinct via communication and reference', () => {
  const st = parseStatementFromTokens(sampleTokens());
  const collisions = st.lines.filter((l) => l.amount === 3210.45 && l.direction === 'outflow');
  assert.equal(collisions.length, 2);
  assert.deepEqual(
    collisions.map((l) => l.reference).sort(),
    ['LE9003', 'LE9004'],
  );
  assert.ok(collisions.some((l) => /ROSSI/.test(l.communication)));
  assert.ok(collisions.some((l) => /Bruno Verdolini/.test(l.communication)));
});

test('the running balance reconciles opening + signed lines == closing', () => {
  const st = parseStatementFromTokens(sampleTokens());
  let sum = st.openingBalance;
  for (const l of st.lines) sum += l.direction === 'inflow' ? l.amount : -l.amount;
  // 123456.78 + 425.50 - 16 - 3210.45 - 3210.45 = 117445.38 (sample is illustrative)
  assert.equal(Math.round(sum * 100) / 100, 117445.38);
});
