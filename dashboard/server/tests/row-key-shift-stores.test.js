// Regression tests for the row-keyed `.gl-data` stores staying aligned when
// banking rows are renumbered. Bugs covered:
// - delete shifted timestamps/checks/attachments but never budget-category
//   overrides (shiftOverridesOnDelete existed but had no callers)
// - compact shifted only overrides; timestamps/checks/attachments had no
//   compact variant at all
// - budget entries' transactionKey was never re-keyed server-side
// These guard the JSON path specifically, so GL_STORE is pinned below — the
// same reason `row-shift-wiring.test.js` pins it. Under `sqlite` an entry's
// link is a `transaction_id`, `transactionKey` is derived from the live row,
// and re-keying it would resolve against rows that have already shifted; the
// shift functions therefore no-op there and there is nothing left to police.
// This file is deleted with the rest of the shift machinery at T16.
process.env.GL_STORE = 'json';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

async function withTempDataDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'row-key-shift-'));
  const project = await import('../services/project.js');
  // Import config first: its top-level bootstrap() opens the real project and
  // would otherwise clobber our override if it ran after setProjectDir below.
  await import('../config.js');
  const previousProjectDir = project.getProjectDir();
  project.setProjectDir(dir);
  try {
    await fn(dir);
  } finally {
    project.setProjectDir(previousProjectDir);
    await rm(dir, { recursive: true, force: true });
  }
}

test('shiftOverridesOnDelete drops the deleted row and shifts overrides below down by one', async () => {
  await withTempDataDir(async () => {
    const { setBudgetCategoryOverride, shiftOverridesOnDelete, getOverridesForMonth } =
      await import('../services/budgetCategoryMap.js');
    await setBudgetCategoryOverride('2098', 'APR', 3, 'Consulenze', 10);
    await setBudgetCategoryOverride('2098', 'APR', 5, 'Software', 11);
    await setBudgetCategoryOverride('2098', 'APR', 6, 'Viaggi', 12);
    await setBudgetCategoryOverride('2098', 'MAG', 6, 'Altro', 13);

    await shiftOverridesOnDelete('2098', 'APR', 5);

    const apr = await getOverridesForMonth('2098', 'APR');
    assert.equal(apr[3].category, 'Consulenze', 'row below deletion untouched');
    assert.equal(apr[5].category, 'Viaggi', 'old row 6 shifted down into row 5');
    assert.equal(apr[6], undefined, 'no stale key remains');
    const mag = await getOverridesForMonth('2098', 'MAG');
    assert.equal(mag[6].category, 'Altro', 'other months untouched');
  });
});

test('shiftTimestampsOnCompact re-keys records via the old→new row map and drops unmapped rows', async () => {
  await withTempDataDir(async () => {
    const { setTimestamp, getTimestamps, shiftTimestampsOnCompact } =
      await import('../services/transactionTimestamps.js');
    await setTimestamp('2098', 'APR', 5);
    await setTimestamp('2098', 'APR', 6);
    await setTimestamp('2098', 'APR', 9); // stale record for a removed blank row
    await setTimestamp('2098', 'MAG', 5);

    // Compact removed a blank row 4: data rows [3, 5, 6] became [3, 4, 5].
    await shiftTimestampsOnCompact('2098', 'APR', new Map([[3, 3], [5, 4], [6, 5]]));

    const ts = await getTimestamps('2098');
    assert.equal(typeof ts['APR-4'], 'string', 'row 5 re-keyed to 4');
    assert.equal(typeof ts['APR-5'], 'string', 'row 6 re-keyed to 5');
    assert.equal(ts['APR-6'], undefined, 'old key gone');
    assert.equal(ts['APR-9'], undefined, 'record for removed row dropped');
    assert.equal(typeof ts['MAG-5'], 'string', 'other months untouched');
  });
});

test('shiftChecksOnCompact re-keys reconciliation checks like the timestamp store', async () => {
  await withTempDataDir(async () => {
    const { setCheck, getChecks, shiftChecksOnCompact } =
      await import('../services/transactionReconciliation.js');
    await setCheck('2098', 'APR', 5, { checked: true, source: 'pdf' });
    await setCheck('2098', 'APR', 6, { checked: true });

    await shiftChecksOnCompact('2098', 'APR', new Map([[5, 3], [6, 4]]));

    const checks = await getChecks('2098');
    assert.equal(checks['APR-3'].source, 'pdf', 'row 5 re-keyed to 3, record preserved');
    assert.equal(checks['APR-4'].checked, true, 'row 6 re-keyed to 4');
    assert.equal(checks['APR-5'], undefined);
    assert.equal(checks['APR-6'], undefined);
  });
});

test('shiftChecksOnDelete drops the deleted row and shifts rows above down by one', async () => {
  await withTempDataDir(async () => {
    const { setCheck, shiftChecksOnDelete, getChecks } =
      await import('../services/transactionReconciliation.js');
    await setCheck('2026', 'APR', 3, { checked: true });
    await setCheck('2026', 'APR', 5, { checked: true, source: 'pdf' });
    await setCheck('2026', 'APR', 6, { checked: true });

    await shiftChecksOnDelete('2026', 'APR', 5);

    const checks = await getChecks('2026');
    assert.equal(checks['APR-3'].checked, true, 'row below deletion is untouched');
    assert.equal(checks['APR-5'].checked, true, 'old row 6 shifted down into row 5');
    assert.equal(checks['APR-5'].source, 'manual', 'shift preserves the original record');
    assert.equal(checks['APR-6'], undefined, 'no stale key remains at the top');
  });
});

test('shiftChecksOnDelete only touches the affected month', async () => {
  await withTempDataDir(async () => {
    const { setCheck, shiftChecksOnDelete, getChecks } =
      await import('../services/transactionReconciliation.js');
    await setCheck('2026', 'APR', 5, { checked: true });
    await setCheck('2026', 'MAG', 5, { checked: true });

    await shiftChecksOnDelete('2026', 'APR', 4);

    const checks = await getChecks('2026');
    assert.equal(checks['APR-4'].checked, true, 'APR row 5 shifted to 4');
    assert.equal(checks['MAG-5'].checked, true, 'MAG untouched');
  });
});

test('shiftAttachmentsOnCompact re-keys attachment records', async () => {
  await withTempDataDir(async () => {
    const { setAttachment, getAttachment, shiftAttachmentsOnCompact } =
      await import('../services/transactionAttachments.js');
    await setAttachment('2098', 'APR', 5, { fileName: 'a.pdf', relativePath: '2098/A/a.pdf' });
    await setAttachment('2098', 'APR', 9, { fileName: 'stale.pdf', relativePath: '2098/S/s.pdf' });

    await shiftAttachmentsOnCompact('2098', 'APR', new Map([[5, 3]]));

    assert.equal((await getAttachment('2098', 'APR', 3)).fileName, 'a.pdf', 'record follows its row');
    assert.equal(await getAttachment('2098', 'APR', 5), null, 'old key gone');
    assert.equal(await getAttachment('2098', 'APR', 9), null, 'record for removed row dropped');
  });
});

async function seedEntriesFile(dir, entries) {
  const glDir = join(dir, '.gl-data');
  await mkdir(glDir, { recursive: true });
  await writeFile(
    join(glDir, 'budget-entries-2098.json'),
    JSON.stringify({ seeded: { certo: false, possibile: false, ottimistico: false }, entries }, null, 2),
    'utf8',
  );
}

function entry(id, transactionKey) {
  return {
    id,
    scenario: 'consuntivo',
    date: '2098-04-10',
    description: `entry ${id}`,
    category: 'Consulenze',
    budgetRow: 10,
    amount: 100,
    payment: 'inMonth',
    notes: '',
    updatedAt: '2098-04-10T00:00:00.000Z',
    ...(transactionKey ? { transactionKey } : {}),
  };
}

test('shiftEntryKeysOnDelete unlinks the deleted row and shifts linked entries below', async () => {
  await withTempDataDir(async (dir) => {
    await seedEntriesFile(dir, [entry('a', 'APR-5'), entry('b', 'APR-9'), entry('c', 'MAG-9')]);
    const { shiftEntryKeysOnDelete, listEntries } = await import('../services/budgetEntries.js');

    await shiftEntryKeysOnDelete('2098', 'APR', 5);

    const { entries } = await listEntries('2098');
    const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
    assert.equal(byId.a.transactionKey, undefined, 'entry linked to the deleted row is unlinked');
    assert.equal(byId.b.transactionKey, 'APR-8', 'entry below the deleted row shifts down');
    assert.equal(byId.c.transactionKey, 'MAG-9', 'other months untouched');
  });
});

test('shiftEntryKeysOnCompact re-keys via the map and unlinks entries for removed rows', async () => {
  await withTempDataDir(async (dir) => {
    await seedEntriesFile(dir, [entry('a', 'APR-5'), entry('b', 'APR-7')]);
    const { shiftEntryKeysOnCompact, listEntries } = await import('../services/budgetEntries.js');

    await shiftEntryKeysOnCompact('2098', 'APR', new Map([[5, 3]]));

    const { entries } = await listEntries('2098');
    const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
    assert.equal(byId.a.transactionKey, 'APR-3');
    assert.equal(byId.b.transactionKey, undefined, 'row not in the map was removed → unlinked');
  });
});

test('retargetEntryKey points a linked entry at the transaction\'s new location', async () => {
  await withTempDataDir(async (dir) => {
    await seedEntriesFile(dir, [entry('a', 'APR-5'), entry('b', 'APR-6')]);
    const { retargetEntryKey, listEntries } = await import('../services/budgetEntries.js');

    await retargetEntryKey('2098', 'APR-5', 'FEB-12');

    const { entries } = await listEntries('2098');
    const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
    assert.equal(byId.a.transactionKey, 'FEB-12');
    assert.equal(byId.b.transactionKey, 'APR-6', 'other entries untouched');
  });
});
