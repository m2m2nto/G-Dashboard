import { test, describe as suite } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTION_BADGES, ACTION_GROUPS, badgeFor, describe } from '../src/components/activityActions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', '..', 'server');

// Every `action: '<name>'` literal the server writes to the audit log, including
// the ternary call sites where two actions share one appendEntry.
function emittedActions() {
  const found = new Set();
  for (const dir of ['routes', 'services']) {
    const base = join(SERVER, dir);
    for (const file of readdirSync(base).filter((f) => f.endsWith('.js'))) {
      const src = readFileSync(join(base, file), 'utf8');
      for (const line of src.split('\n')) {
        if (!/\baction:/.test(line)) continue;
        for (const m of line.matchAll(/'([a-z][a-z0-9]*(?:[.-][a-z0-9]+)+)'/gi)) found.add(m[1]);
      }
    }
  }
  return [...found];
}

suite('activity badges', () => {
  test('every audit action the server emits has a badge label and help text', () => {
    const missing = emittedActions().filter((a) => !ACTION_BADGES[a]);
    assert.deepEqual(missing, [], `unlabelled audit actions: ${missing.join(', ')}`);
  });

  test('the scan actually finds the known actions (guards against a broken regex)', () => {
    const actions = emittedActions();
    for (const known of ['store.consistency', 'attachment.verify', 'transaction.add', 'transaction.uncheck']) {
      assert.ok(actions.includes(known), `scan missed ${known}`);
    }
  });

  test('every badge has a non-empty label, colour and help', () => {
    for (const [action, badge] of Object.entries(ACTION_BADGES)) {
      assert.ok(badge.label, `${action} has no label`);
      assert.ok(badge.color, `${action} has no colour`);
      assert.ok(badge.help?.length > 10, `${action} has no help text`);
    }
  });

  test('the legend lists every badge exactly once', () => {
    const listed = ACTION_GROUPS.flatMap((g) => g.actions);
    assert.equal(listed.length, new Set(listed).size, 'an action is listed in two legend groups');
    assert.deepEqual([...listed].sort(), Object.keys(ACTION_BADGES).sort());
  });

  test('an unknown action still renders as a neutral badge', () => {
    assert.equal(badgeFor('future.thing').label, 'future.thing');
    assert.ok(badgeFor('future.thing').color);
  });
});

suite('activity descriptions', () => {
  test('previously unlabelled actions render human text, not the raw action', () => {
    const entries = [
      { action: 'store.consistency', details: { checked: 12, divergences: 0, months: [] } },
      { action: 'store.import', details: { rows: 340 } },
      { action: 'attachment.verify', details: { verified: 8, updated: 1 } },
      { action: 'transaction.compact', year: '2026', month: 'AGO', details: { removed: 3 } },
      { action: 'transaction.check', details: { row: 12, transaction: 'Stipendi' } },
      { action: 'transaction.reconcile.apply', details: { rows: [1, 2], count: 2 } },
      { action: 'cf-budget-map.update', details: { cfCategory: 'C-STIPENDI', from: null, to: 'Personale' } },
      { action: 'element.create', details: { element: 'ACME', category: 'C-FORNITORI' } },
      { action: 'invoice.add', details: { row: 4, invoiceNumber: '2026-011', recipient: 'ACME', amount: 1200 } },
      { action: 'transaction.attachment.move', details: { row: 7, to: '2026/AGO/f.pdf' } },
    ];
    for (const entry of entries) {
      const text = describe(entry);
      assert.notEqual(text, entry.action, `${entry.action} still renders the raw action name`);
      assert.ok(text.length > 0);
    }
  });

  test('store.consistency spells out divergent months when there are any', () => {
    const clean = describe({ action: 'store.consistency', details: { checked: 12, divergences: 0, months: [] } });
    assert.equal(clean, '12 months checked, no divergence');
    const dirty = describe({ action: 'store.consistency', details: { checked: 12, divergences: 1, months: ['2026 AGO'] } });
    assert.equal(dirty, '12 months checked, 1 divergence — 2026 AGO');
  });

  test('attachment.verify reports what was verified and updated', () => {
    assert.equal(
      describe({ action: 'attachment.verify', details: { verified: 8, updated: 1 } }),
      '8 attachments verified, 1 updated',
    );
  });

  test('existing descriptions are unchanged', () => {
    assert.equal(
      describe({ action: 'cashflow.sync-all', year: '2026' }),
      'Synced all months 2026',
    );
    assert.equal(
      describe({ action: 'element.category', details: { element: 'ACME', from: null, to: 'C-FORNITORI' } }),
      'ACME: none → C-FORNITORI',
    );
    assert.equal(
      describe({ action: 'budget.refresh', details: { scenario: 'base', created: 2, skipped: 5 } }),
      'Refreshed base — 2 adjustments, 5 matched',
    );
  });
});
