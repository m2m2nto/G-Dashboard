// Copy for the Legacy Import pane. Delete with the feature (tasks/todo.md T30).
//
// The pane's whole job is to not overclaim: the importer skips any non-empty
// table, so "there are rows and an archive" cannot be read as "the archive was
// imported" — something else may have written first and closed the gate.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeLegacyImport,
  summarizeLegacyImport,
  LEGACY_STORES,
} from '../src/components/settings/legacyImport.js';

const migrated = {
  auditLog: { rows: 1060, archiveFound: true },
  cfBudgetMap: { rows: 19, archiveFound: true },
  folderMemory: { rows: 45, archiveFound: true },
  invoiceAttachments: { rows: 10, archiveFound: true },
};

describe('status before a run', () => {
  test('a populated table never claims the archive was imported', () => {
    const rows = describeLegacyImport(migrated);
    const audit = rows.find((r) => r.key === 'auditLog');
    assert.equal(audit.state, 'stored');
    assert.match(audit.text, /1060 records in the database/);
    assert.match(audit.text, /archive on disk is not read/);
    assert.doesNotMatch(audit.text, /imported/i, 'it cannot know that, so it must not say it');
  });

  test('an archive beside an empty table is the one state that needs the button', () => {
    const rows = describeLegacyImport({
      ...migrated,
      cfBudgetMap: { rows: 0, archiveFound: true },
    });
    assert.equal(rows.find((r) => r.key === 'cfBudgetMap').state, 'pending');
    assert.equal(summarizeLegacyImport(rows).pending, 1);
    assert.equal(summarizeLegacyImport(rows).tone, 'warning');
  });

  test('a fully migrated project reports nothing to do — the condition for deleting all of this', () => {
    const summary = summarizeLegacyImport(describeLegacyImport(migrated));
    assert.equal(summary.pending, 0);
    assert.equal(summary.tone, 'positive');
  });

  test('no archive and no rows is not a problem worth flagging', () => {
    const rows = describeLegacyImport({ folderMemory: { rows: 0, archiveFound: false } });
    assert.equal(rows.find((r) => r.key === 'folderMemory').state, 'empty');
    assert.equal(summarizeLegacyImport(rows).pending, 0);
  });

  test('a missing payload renders every store rather than throwing', () => {
    const rows = describeLegacyImport(null);
    assert.equal(rows.length, LEGACY_STORES.length);
    assert.deepEqual(rows.map((r) => r.state), rows.map(() => 'empty'));
  });
});

describe('results after a run', () => {
  test('each reason reads as its own outcome', () => {
    const rows = describeLegacyImport(
      {
        auditLog: { rows: 3, archiveFound: true },
        cfBudgetMap: { rows: 19, archiveFound: true },
        folderMemory: { rows: 0, archiveFound: false },
        invoiceAttachments: { rows: 1, archiveFound: true },
      },
      {
        auditLog: { imported: 3, reason: 'imported' },
        cfBudgetMap: { imported: 0, reason: 'already-populated' },
        folderMemory: { imported: 0, reason: 'no-archive' },
        invoiceAttachments: { imported: 1, reason: 'imported' },
      },
    );
    const text = Object.fromEntries(rows.map((r) => [r.key, r.text]));
    assert.equal(text.auditLog, 'Imported 3 records');
    assert.equal(text.cfBudgetMap, 'Skipped — the table already holds 19 records');
    assert.equal(text.folderMemory, 'Skipped — no archive on disk');
    assert.equal(text.invoiceAttachments, 'Imported 1 record', 'singular');
  });
});
