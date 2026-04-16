import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTransactionPayload, attachTransactionMetadata, parseTransactionRouteParams } from '../routes/transactions.js';

test('rejects invalid IBAN format', () => {
  const { error } = validateTransactionPayload(
    {
      date: '2026-01-01',
      transaction: 'Test',
      inflow: 10,
      iban: 'NOT-AN-IBAN',
    },
    { partial: false }
  );

  assert.ok(error);
  assert.match(error, /IBAN/i);
});

test('rejects update with both inflow and outflow', () => {
  const { error } = validateTransactionPayload(
    { inflow: 10, outflow: 5 },
    { partial: true }
  );

  assert.ok(error);
  assert.match(error, /Only one of inflow or outflow/i);
});

test('normalizes IBAN spacing and case', () => {
  const { cleaned, error } = validateTransactionPayload(
    {
      date: '2026-01-01',
      transaction: 'Test',
      inflow: 10,
      iban: 'lu28  0019 4006 4475 0000',
    },
    { partial: false }
  );

  assert.ifError(error);
  assert.equal(cleaned.iban, 'LU280019400644750000');
});

// --- Category / flow direction mismatch tests ---

test('rejects outflow with Revenue (R-) category', () => {
  const { error } = validateTransactionPayload(
    {
      date: '2026-01-01',
      transaction: 'Test',
      outflow: 100,
      cashFlow: 'R-ALTRO',
    },
    { partial: false }
  );

  assert.ok(error);
  assert.match(error, /Outflow.*Cost/i);
  assert.match(error, /Revenue\/Financing/i);
});

test('rejects inflow with Cost (C-) category', () => {
  const { error } = validateTransactionPayload(
    {
      date: '2026-01-01',
      transaction: 'Test',
      inflow: 100,
      cashFlow: 'C-SPESE EXTRA',
    },
    { partial: false }
  );

  assert.ok(error);
  assert.match(error, /Inflow.*Revenue or Financing/i);
});

test('accepts outflow with Cost (C-) category', () => {
  const { cleaned, error } = validateTransactionPayload(
    {
      date: '2026-01-01',
      transaction: 'Test',
      outflow: 100,
      cashFlow: 'C-SPESE EXTRA',
    },
    { partial: false }
  );

  assert.ifError(error);
  assert.equal(cleaned.cashFlow, 'C-SPESE EXTRA');
});

test('accepts inflow with Revenue (R-) category', () => {
  const { cleaned, error } = validateTransactionPayload(
    {
      date: '2026-01-01',
      transaction: 'Test',
      inflow: 100,
      cashFlow: 'R-ALTRO',
    },
    { partial: false }
  );

  assert.ifError(error);
  assert.equal(cleaned.cashFlow, 'R-ALTRO');
});

test('accepts inflow with Financing (R-FINANZIAMENTO SOCI) category', () => {
  const { cleaned, error } = validateTransactionPayload(
    {
      date: '2026-01-01',
      transaction: 'Shareholder loan',
      inflow: 5000,
      cashFlow: 'R-FINANZIAMENTO SOCI',
    },
    { partial: false }
  );

  assert.ifError(error);
  assert.equal(cleaned.cashFlow, 'R-FINANZIAMENTO SOCI');
});

test('allows category without flow in partial update', () => {
  const { cleaned, error } = validateTransactionPayload(
    { cashFlow: 'C-SPESE EXTRA' },
    { partial: true }
  );

  assert.ifError(error);
  assert.equal(cleaned.cashFlow, 'C-SPESE EXTRA');
});

test('parseTransactionRouteParams validates month and row when present', () => {
  assert.deepEqual(parseTransactionRouteParams({ year: '2026', month: 'apr', row: '12' }), {
    year: '2026',
    month: 'APR',
    row: 12,
  });

  assert.match(parseTransactionRouteParams({ year: '2026', month: 'bad', row: '12' }).error, /Invalid month/i);
  assert.match(parseTransactionRouteParams({ year: '2026', month: 'apr', row: '2' }).error, /Invalid row/i);
});

test('attachTransactionMetadata adds budget timestamp and attachment data to rows', () => {
  const rows = [
    {
      row: 12,
      cashFlow: 'C-SPESE EXTRA',
      transaction: 'ACME SRL',
    },
    {
      row: 13,
      cashFlow: 'R-ALTRO',
      transaction: 'Client X',
    },
  ];

  attachTransactionMetadata(rows, {
    month: 'APR',
    txBudgetMap: {
      12: { category: 'Custom Budget', budgetRow: 44 },
    },
    cfBudgetMap: {
      'R-ALTRO': { budgetCategory: 'Revenue Budget', budgetRow: 22 },
    },
    timestamps: {
      'APR-12': '2026-04-12T10:16:00.000Z',
    },
    attachments: {
      'APR-12': {
        relativePath: '2026/ACME SRL/20260410 - ACME SRL.pdf',
        fileName: '20260410 - ACME SRL.pdf',
        status: 'present',
        lastVerifiedAt: '2026-04-12T10:16:00.000Z',
        storageMode: 'uploaded',
      },
    },
  });

  assert.equal(rows[0].budgetCategory, 'Custom Budget');
  assert.equal(rows[0].budgetRow, 44);
  assert.equal(rows[0].updatedAt, '2026-04-12T10:16:00.000Z');
  assert.deepEqual(rows[0].attachment, {
    relativePath: '2026/ACME SRL/20260410 - ACME SRL.pdf',
    fileName: '20260410 - ACME SRL.pdf',
    status: 'present',
    lastVerifiedAt: '2026-04-12T10:16:00.000Z',
    storageMode: 'uploaded',
  });

  assert.equal(rows[1].budgetCategory, 'Revenue Budget');
  assert.equal(rows[1].budgetRow, 22);
  assert.equal(rows[1].attachment, undefined);
});
