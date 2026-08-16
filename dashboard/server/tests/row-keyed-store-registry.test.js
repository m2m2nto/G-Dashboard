// Tests for the row-keyed store registry (services/rowKeyedStores.js).
//
// WHY THIS FILE EXISTS, on top of the two tests that already cover shifting:
//   - row-key-shift-stores.test.js proves each `shift*` function works when
//     called directly.
//   - row-shift-wiring.test.js proves the DELETE and COMPACT routes shift the
//     five stores, by driving the real router over HTTP.
// Neither can prove that a store added to the registry is picked up by every
// path, nor that the registry itself is complete. That is what this file does:
// it asserts over ROW_KEYED_STORES itself, so a sixth store registered without
// a compact handler — or a path that goes around the registry — turns red.

import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- stubs -----------------------------------------------------------------
// Each store module is replaced once (node:test forbids re-mocking) with a
// recorder. `Check` always throws, which is how the "one bad store must not
// stop the others" guarantee gets exercised.

/** @type {string[]} */
const calls = [];
const rec = (label) => async (/** @type {any[]} */ ...args) => {
  calls.push(`${label}:${JSON.stringify(args.slice(1), (_k, v) => (v instanceof Map ? [...v] : v))}`);
};
const failing = (label) => async () => { throw new Error(`${label} exploded`); };

test.mock.module('../services/budgetCategoryMap.js', {
  namedExports: { shiftOverridesOnDelete: rec('Override.delete'), shiftOverridesOnCompact: rec('Override.compact') },
});
test.mock.module('../services/transactionTimestamps.js', {
  namedExports: { shiftTimestampsOnDelete: rec('Timestamp.delete'), shiftTimestampsOnCompact: rec('Timestamp.compact') },
});
test.mock.module('../services/transactionReconciliation.js', {
  namedExports: { shiftChecksOnDelete: failing('Check.delete'), shiftChecksOnCompact: failing('Check.compact') },
});
test.mock.module('../services/transactionAttachments.js', {
  namedExports: { shiftAttachmentsOnDelete: rec('Attachment.delete'), shiftAttachmentsOnCompact: rec('Attachment.compact') },
});
test.mock.module('../services/transactionInvoices.js', {
  namedExports: { shiftInvoiceLinksOnDelete: rec('Invoice link.delete'), shiftInvoiceLinksOnCompact: rec('Invoice link.compact') },
});
test.mock.module('../services/budgetEntries.js', {
  namedExports: { shiftEntryKeysOnDelete: rec('Budget-entry key.delete'), shiftEntryKeysOnCompact: rec('Budget-entry key.compact') },
});

const { ROW_KEYED_STORES, shiftAllOnDelete, shiftAllOnCompact } = await import('../services/rowKeyedStores.js');

beforeEach(() => { calls.length = 0; });

describe('registry shape', () => {
  test('every registered store has a name and both shift handlers', () => {
    assert.ok(ROW_KEYED_STORES.length >= 5, 'registry unexpectedly small');
    for (const store of ROW_KEYED_STORES) {
      assert.equal(typeof store.name, 'string', 'store needs a name for failure logs');
      assert.ok(store.name.length > 0);
      assert.equal(typeof store.onDelete, 'function', `${store.name} is missing onDelete`);
      assert.equal(typeof store.onCompact, 'function', `${store.name} is missing onCompact`);
    }
  });

  test('registers the six known row-keyed stores', () => {
    assert.deepEqual(
      ROW_KEYED_STORES.map((s) => s.name).sort(),
      ['Attachment', 'Budget-entry key', 'Check', 'Invoice link', 'Override', 'Timestamp']
    );
  });

  test('budget entries are shifted LAST', () => {
    // editTransaction calls retargetEntryKey immediately before shiftAllOnDelete
    // and relies on the budget-entry shift running after the other four; moving
    // it earlier would let the shift undo the retarget on a cross-month move.
    assert.equal(ROW_KEYED_STORES[ROW_KEYED_STORES.length - 1].name, 'Budget-entry key');
  });
});

describe('shiftAll fans out to every registered store', () => {
  test('shiftAllOnDelete reaches every store; a failing store does not stop the others', async (t) => {
    const errors = [];
    t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));

    await shiftAllOnDelete('2098', 'APR', 7);

    assert.deepEqual(calls, [
      'Override.delete:["APR",7]',
      'Timestamp.delete:["APR",7]',
      // Check.delete threw — deliberately absent, and the run continued past it
      'Attachment.delete:["APR",7]',
      'Invoice link.delete:["APR",7]',
      'Budget-entry key.delete:["APR",7]',
    ]);
    assert.ok(
      errors.some((e) => e.includes('Check shift on delete failed')),
      `the failing store must be logged by name, got: ${JSON.stringify(errors)}`
    );
  });

  test('shiftAllOnCompact reaches every store with the old→new map intact', async (t) => {
    const errors = [];
    t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));

    await shiftAllOnCompact('2098', 'APR', new Map([[5, 3], [6, 4]]));

    assert.deepEqual(calls, [
      'Override.compact:["APR",[[5,3],[6,4]]]',
      'Timestamp.compact:["APR",[[5,3],[6,4]]]',
      'Attachment.compact:["APR",[[5,3],[6,4]]]',
      'Invoice link.compact:["APR",[[5,3],[6,4]]]',
      'Budget-entry key.compact:["APR",[[5,3],[6,4]]]',
    ]);
    assert.ok(errors.some((e) => e.includes('Check shift on compact failed')));
  });
});

describe('no path goes around the registry', () => {
  test('only rowKeyedStores.js imports the individual shift* functions', async () => {
    // A new delete/compact path that imports shift* directly would silently
    // shift only the stores its author remembered — the exact failure this
    // registry exists to prevent.
    const offenders = [];
    for (const dir of ['services', 'routes']) {
      const files = (await readdir(join(serverDir, dir))).filter((f) => f.endsWith('.js'));
      for (const file of files) {
        if (file === 'rowKeyedStores.js') continue; // the one sanctioned importer
        const src = await readFile(join(serverDir, dir, file), 'utf8');
        // Only IMPORTS count — the store modules themselves obviously define
        // these functions. Matches multi-line import blocks too.
        const imports = src.match(/import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]/g) || [];
        if (imports.some((i) => /\bshift(Overrides|Timestamps|Checks|Attachments|InvoiceLinks|EntryKeys)On(Delete|Compact)\b/.test(i))) {
          offenders.push(`${dir}/${file}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these modules reference a row-keyed shift function directly instead of ` +
        `using shiftAllOnDelete/shiftAllOnCompact, so they can shift an ` +
        `incomplete set of stores: ${offenders.join(', ')}`
    );
  });
});
