import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileStatement } from '../services/statementReconciler.js';

function line(over) {
  return {
    date: '2026-04-01',
    valueDate: '2026-04-01',
    type: 'VIREMENT SEPA',
    reference: '',
    communication: '',
    description: '',
    amount: 0,
    direction: 'outflow',
    ...over,
  };
}

function statement(lines, over = {}) {
  return {
    iban: 'LU219990000012345678',
    period: { from: '2026-04-01', to: '2026-04-30' },
    openingBalance: 1000,
    closingBalance: 0,
    lines,
    ...over,
  };
}

function tx(over) {
  return { row: 3, date: '2026-04-01', transaction: '', inflow: null, outflow: null, ...over };
}

test('matches a clean outflow on date + amount as confident', () => {
  const st = statement([
    line({ date: '2026-04-07', valueDate: '2026-04-07', amount: 90, direction: 'outflow', description: 'PAYS USA/ANTHROPIC.COM CLAUDE.AI SUBSCRIPTION' }),
  ]);
  const txs = [tx({ row: 5, date: '2026-04-07', transaction: 'Anthropic', outflow: 90 })];
  const report = reconcileStatement(st, txs);
  assert.equal(report.matched.length, 1);
  assert.equal(report.matched[0].confidence, 'confident');
  assert.equal(report.matched[0].app.row, 5);
  assert.equal(report.missing.length, 0);
  assert.equal(report.extra.length, 0);
});

test('inflow vs outflow direction is respected', () => {
  const st = statement([line({ amount: 500, direction: 'inflow', description: 'CLIENT PAYMENT' })]);
  const txs = [tx({ row: 4, date: '2026-04-01', transaction: 'Client', outflow: 500 })]; // wrong direction
  const report = reconcileStatement(st, txs);
  assert.equal(report.matched.length, 0);
  assert.equal(report.missing.length, 1, 'inflow line unmatched');
  assert.equal(report.extra.length, 1, 'outflow tx is extra');
});

test('same date + amount collision is disambiguated by name', () => {
  const st = statement([
    line({ date: '2026-04-30', amount: 3210.45, direction: 'outflow', communication: 'Stipendio 04/2026 MARIO-ALDO ROSSI', description: 'VIREMENT SEPA Stipendio 04/2026 MARIO-ALDO ROSSI' }),
    line({ date: '2026-04-30', amount: 3210.45, direction: 'outflow', communication: 'Stipendio 04/2026 Bruno Verdolini', description: 'VIREMENT SEPA Stipendio 04/2026 Bruno Verdolini' }),
  ]);
  const txs = [
    tx({ row: 10, date: '2026-04-30', transaction: 'Bruno Verdolini', outflow: 3210.45 }),
    tx({ row: 11, date: '2026-04-30', transaction: 'Mario-Aldo Rossi', outflow: 3210.45 }),
  ];
  const report = reconcileStatement(st, txs);
  assert.equal(report.matched.length, 2);
  const rossi = report.matched.find((m) => /ROSSI/.test(m.communication));
  const verdo = report.matched.find((m) => /Verdolini/.test(m.communication));
  assert.equal(rossi.app.row, 11, 'Rossi line matched the Rossi row');
  assert.equal(verdo.app.row, 10, 'Verdolini line matched the Verdolini row');
  assert.equal(report.extra.length, 0);
  assert.equal(report.missing.length, 0);
});

test('collision with indistinguishable names still consumes distinct rows', () => {
  const st = statement([
    line({ date: '2026-04-30', amount: 100, direction: 'outflow', description: 'Stipendio' }),
    line({ date: '2026-04-30', amount: 100, direction: 'outflow', description: 'Stipendio' }),
  ]);
  const txs = [
    tx({ row: 7, date: '2026-04-30', transaction: 'Stipendio', outflow: 100 }),
    tx({ row: 8, date: '2026-04-30', transaction: 'Stipendio', outflow: 100 }),
  ];
  const report = reconcileStatement(st, txs);
  assert.equal(report.matched.length, 2);
  assert.deepEqual(report.matched.map((m) => m.app.row).sort(), [7, 8], 'each row used once');
  assert.equal(report.extra.length, 0);
});

test('statement line missing from the app is reported as missing', () => {
  const st = statement([line({ date: '2026-04-01', amount: 16, direction: 'outflow', type: 'TENUE DE COMPTE', description: 'TENUE DE COMPTE Frais pack confort pro' })]);
  const report = reconcileStatement(st, []);
  assert.equal(report.missing.length, 1);
  assert.equal(report.missing[0].amount, 16);
  assert.equal(report.matched.length, 0);
});

test('app transaction not on the statement is reported as extra', () => {
  const st = statement([]);
  const txs = [tx({ row: 9, date: '2026-04-12', transaction: 'Cassa contanti', outflow: 50 })];
  const report = reconcileStatement(st, txs);
  assert.equal(report.extra.length, 1);
  assert.equal(report.extra[0].row, 9);
  assert.equal(report.extra[0].amount, 50);
});

test('amount match with a far-off date is flagged for review, not confident', () => {
  const st = statement([line({ date: '2026-04-27', valueDate: '2026-04-27', amount: 60, direction: 'outflow', description: 'Proximus' })]);
  const txs = [tx({ row: 6, date: '2026-04-02', transaction: 'Proximus', outflow: 60 })];
  const report = reconcileStatement(st, txs);
  assert.equal(report.matched.length, 1);
  assert.equal(report.matched[0].confidence, 'review');
});

test('value date within the app date is accepted as confident', () => {
  const st = statement([line({ date: '2026-04-26', valueDate: '2026-04-27', amount: 321.99, direction: 'outflow', description: 'ENOVOS' })]);
  const txs = [tx({ row: 12, date: '2026-04-27', transaction: 'Enovos', outflow: 321.99 })];
  const report = reconcileStatement(st, txs);
  assert.equal(report.matched[0].confidence, 'confident');
});

test('balance check compares statement closing to app closing', () => {
  const st = statement([], { closingBalance: 98765.43 });
  const ok = reconcileStatement(st, [], { appClosingBalance: 98765.43 });
  assert.equal(ok.balance.matches, true);
  const off = reconcileStatement(st, [], { appClosingBalance: 98700.0 });
  assert.equal(off.balance.matches, false);
  assert.equal(off.balance.statementClosing, 98765.43);
  assert.equal(off.balance.appClosing, 98700.0);
});
