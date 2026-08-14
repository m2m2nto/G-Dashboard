import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDirty } from '../src/hooks/useSettingsForm.js';

const v1Paths = {
  bankingFile: '/proj/bank.xlsx',
  cashFlowFile: '/proj/cf.xlsx',
  archiveDir: '/proj/archive',
  attachmentRoot: '/proj/att',
  budgetFile: '',
  transactionFiles: {},
};

const v1Orig = {
  bankingFile: '/proj/bank.xlsx',
  cashFlowFile: '/proj/cf.xlsx',
  archiveDir: '/proj/archive',
  attachmentRoot: '/proj/att',
};

test('v1 equal snapshot is not dirty', () => {
  assert.equal(computeDirty(v1Paths, v1Orig, false), false);
});

test('v1 mutation of bankingFile marks dirty', () => {
  assert.equal(computeDirty({ ...v1Paths, bankingFile: '/proj/new.xlsx' }, v1Orig, false), true);
});

test('v1 mutation of cashFlowFile marks dirty', () => {
  assert.equal(computeDirty({ ...v1Paths, cashFlowFile: '/proj/new.xlsx' }, v1Orig, false), true);
});

test('v1 mutation of archiveDir marks dirty', () => {
  assert.equal(computeDirty({ ...v1Paths, archiveDir: '/proj/other' }, v1Orig, false), true);
});

test('v1 mutation of attachmentRoot marks dirty', () => {
  assert.equal(computeDirty({ ...v1Paths, attachmentRoot: '/proj/other' }, v1Orig, false), true);
});

test('v1 ignores v2-only fields (budgetFile, transactionFiles)', () => {
  const paths = { ...v1Paths, budgetFile: '/proj/b.xlsx', transactionFiles: { '2025': '/x' } };
  assert.equal(computeDirty(paths, v1Orig, false), false);
});

const v2Paths = {
  bankingFile: '',
  archiveDir: '',
  cashFlowFile: '/proj/cf.xlsx',
  budgetFile: '/proj/budget.xlsx',
  attachmentRoot: '/proj/att',
  transactionFiles: { '2024': '/proj/tx-2024.xlsx', '2025': '/proj/tx-2025.xlsx' },
};

const v2Orig = {
  cashFlowFile: '/proj/cf.xlsx',
  budgetFile: '/proj/budget.xlsx',
  attachmentRoot: '/proj/att',
  transactionFiles: { '2024': '/proj/tx-2024.xlsx', '2025': '/proj/tx-2025.xlsx' },
};

test('v2 equal snapshot is not dirty', () => {
  assert.equal(computeDirty(v2Paths, v2Orig, true), false);
});

test('v2 mutation of cashFlowFile marks dirty', () => {
  assert.equal(computeDirty({ ...v2Paths, cashFlowFile: '/proj/new.xlsx' }, v2Orig, true), true);
});

test('v2 mutation of budgetFile marks dirty', () => {
  assert.equal(computeDirty({ ...v2Paths, budgetFile: '/proj/new.xlsx' }, v2Orig, true), true);
});

test('v2 mutation of attachmentRoot marks dirty', () => {
  assert.equal(computeDirty({ ...v2Paths, attachmentRoot: '/proj/other' }, v2Orig, true), true);
});

test('v2 transactionFiles add marks dirty', () => {
  const paths = { ...v2Paths, transactionFiles: { ...v2Paths.transactionFiles, '2026': '/proj/tx-2026.xlsx' } };
  assert.equal(computeDirty(paths, v2Orig, true), true);
});

test('v2 transactionFiles remove marks dirty', () => {
  const paths = { ...v2Paths, transactionFiles: { '2025': '/proj/tx-2025.xlsx' } };
  assert.equal(computeDirty(paths, v2Orig, true), true);
});

test('v2 transactionFiles rename marks dirty', () => {
  const paths = {
    ...v2Paths,
    transactionFiles: { '2024': '/proj/tx-2024-v2.xlsx', '2025': '/proj/tx-2025.xlsx' },
  };
  assert.equal(computeDirty(paths, v2Orig, true), true);
});

test('v2 ignores v1-only fields (bankingFile, archiveDir)', () => {
  const paths = { ...v2Paths, bankingFile: '/proj/stale.xlsx', archiveDir: '/proj/stale' };
  assert.equal(computeDirty(paths, v2Orig, true), false);
});
