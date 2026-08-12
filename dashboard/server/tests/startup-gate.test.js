import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStartupGate } from '../services/startupGate.js';

/**
 * Regression: the one-time JSON→SQLite import ran inside the `app.listen`
 * callback, so `/api/*` was already answering while `cf_budget_map` was still
 * empty. `budgetSummaryCents` then resolved only the per-row Overrides, every
 * CF-mapped Transaction dropped out of the by-budget summary, and the Cash Flow
 * Overview showed "data does not match the Lux Cash Flow" with diffs equal to
 * the whole mapped amount — wrong numbers, no error.
 */

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

describe('startup gate', () => {
  test('no request is handled before the import finishes', async () => {
    let finishImport;
    const gate = createStartupGate(() => new Promise((resolve) => { finishImport = resolve; }));

    let handled = false;
    const res = fakeRes();
    const pending = gate({}, res, () => { handled = true; });

    // Drain the microtask queue: without the gate the request would be through
    // by now, which is exactly the window that served the empty mapping.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(handled, false, 'request reached the route before the import finished');
    assert.equal(res.statusCode, null);

    finishImport();
    await pending;
    assert.equal(handled, true, 'request was not released once the import finished');
  });

  test('requests arriving after the import finished pass straight through', async () => {
    const gate = createStartupGate(async () => {});
    await new Promise((resolve) => setImmediate(resolve));

    let handled = false;
    await gate({}, fakeRes(), () => { handled = true; });
    assert.equal(handled, true);
  });

  test('a failed import answers 503 rather than serving a half-imported store', async () => {
    const gate = createStartupGate(async () => { throw new Error('audit archive unreadable'); });

    let handled = false;
    const res = fakeRes();
    await gate({}, res, () => { handled = true; });

    assert.equal(handled, false, 'a failed import must not be waved through');
    assert.equal(res.statusCode, 503);
    assert.match(res.body.error, /audit archive unreadable/);
  });

  test('the import runs once, however many requests arrive', async () => {
    let runs = 0;
    const gate = createStartupGate(async () => { runs += 1; });

    await Promise.all([
      gate({}, fakeRes(), () => {}),
      gate({}, fakeRes(), () => {}),
      gate({}, fakeRes(), () => {}),
    ]);
    assert.equal(runs, 1);
  });
});

describe('startup gate wiring', () => {
  const indexSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js'),
    'utf8',
  );

  test('the import is gated, not fired inside the listen callback', () => {
    const gateIdx = indexSrc.indexOf("app.use('/api', createStartupGate(");
    const listenIdx = indexSrc.indexOf('app.listen(');
    assert.ok(gateIdx !== -1, 'the startup gate is no longer mounted on /api');
    assert.ok(
      gateIdx < listenIdx,
      'importRemainingStores must run behind the gate, not inside app.listen',
    );
    assert.ok(
      indexSrc.indexOf('importRemainingStores(') < listenIdx,
      'importRemainingStores moved back after app.listen — requests would be served mid-import',
    );
  });

  test('the gate is mounted ahead of every /api router', () => {
    const gateIdx = indexSrc.indexOf("app.use('/api', createStartupGate(");
    for (const match of indexSrc.matchAll(/app\.use\('\/api\/[^']+'/g)) {
      assert.ok(
        match.index > gateIdx,
        `${match[0]} is mounted before the startup gate and would bypass it`,
      );
    }
  });
});
