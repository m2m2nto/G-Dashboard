// Settings dialog side menu: which panes are offered, and how a pane reports a
// problem the user cannot see because another pane is open.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSettingsSections, resolveActiveSection } from '../src/components/settings/settingsSections.js';

const ids = (sections) => sections.map((s) => s.id);
const badgeOf = (sections, id) => sections.find((s) => s.id === id).badge;

test('v2 offers project, attachments, cash flow, budget, transactions and database', () => {
  const sections = buildSettingsSections({ isV2: true });
  assert.deepEqual(ids(sections), ['project', 'attachments', 'cashflow', 'budget', 'transactions', 'database']);
});

test('v1 offers the same panes without budget', () => {
  const sections = buildSettingsSections({ isV2: false });
  assert.deepEqual(ids(sections), ['project', 'attachments', 'cashflow', 'transactions', 'database']);
});

test('no badges when every file checks out', () => {
  const sections = buildSettingsSections({
    isV2: true,
    fileStatus: { attachmentRoot: true, cashFlowFile: true, budgetFile: true },
    txFileStatus: { 2025: true, 2026: true },
  });
  assert.deepEqual(sections.map((s) => s.badge), [null, null, null, null, null, null]);
});

test('a missing file badges its pane as an error', () => {
  const sections = buildSettingsSections({ isV2: true, fileStatus: { cashFlowFile: false } });
  assert.equal(badgeOf(sections, 'cashflow'), 'error');
  assert.equal(badgeOf(sections, 'budget'), null);
});

test('a file that exists but has problems badges its pane as a warning', () => {
  const sections = buildSettingsSections({
    isV2: true,
    fileStatus: { budgetFile: true },
    fileProblems: { budgetFile: ['Missing sheet 2026'] },
  });
  assert.equal(badgeOf(sections, 'budget'), 'warning');
});

test('a wrong-type file — problems plus a failed check — badges as an error, not a warning', () => {
  const sections = buildSettingsSections({
    isV2: true,
    fileStatus: { cashFlowFile: false },
    fileProblems: { cashFlowFile: ['This looks like a Budget file'] },
  });
  assert.equal(badgeOf(sections, 'cashflow'), 'error');
});

test('v2 transaction pane carries the worst status across years', () => {
  const warned = buildSettingsSections({
    isV2: true,
    txFileStatus: { 2025: true, 2026: true },
    txFileProblems: { 2026: ['Missing sheet DIC'] },
  });
  assert.equal(badgeOf(warned, 'transactions'), 'warning');

  const failed = buildSettingsSections({
    isV2: true,
    txFileStatus: { 2025: false, 2026: true },
    txFileProblems: { 2026: ['Missing sheet DIC'] },
  });
  assert.equal(badgeOf(failed, 'transactions'), 'error');
});

test('v1 transaction pane covers both the banking file and the archive dir', () => {
  const banking = buildSettingsSections({ isV2: false, fileStatus: { bankingFile: false, archiveDir: true } });
  assert.equal(badgeOf(banking, 'transactions'), 'error');

  const archive = buildSettingsSections({ isV2: false, fileStatus: { bankingFile: true, archiveDir: false } });
  assert.equal(badgeOf(archive, 'transactions'), 'error');
});

test('resolveActiveSection keeps a section that is still offered', () => {
  const sections = buildSettingsSections({ isV2: true });
  assert.equal(resolveActiveSection(sections, 'budget'), 'budget');
});

test('resolveActiveSection falls back to the first pane when the section is gone', () => {
  const sections = buildSettingsSections({ isV2: false });
  assert.equal(resolveActiveSection(sections, 'budget'), 'project');
});
