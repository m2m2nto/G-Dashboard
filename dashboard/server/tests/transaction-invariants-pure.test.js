// @ts-check
// Also pins the type contract of services/transactionInvariants.js: the
// `@ts-expect-error` test below requires the next statement to fail type
// checking under `npm run typecheck`. If the type ever loosens (e.g.,
// CashFlowCategory becomes plain string), `@ts-expect-error` itself becomes
// the error and flags the regression.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTransactionInvariants } from '../services/transactionInvariants.js';

test('valid C- + outflow passes', () => {
  assertTransactionInvariants({ outflow: 100, cashFlow: 'C-SPESE EXTRA' });
});

test('valid R- + inflow passes', () => {
  assertTransactionInvariants({ inflow: 100, cashFlow: 'R-ALTRO' });
});

test('C- + inflow throws a direction-mismatch error', () => {
  assert.throws(
    () => assertTransactionInvariants({ inflow: 100, cashFlow: 'C-SPESE EXTRA' }),
    /Direction\/category mismatch/,
  );
});

test('R- + outflow throws a direction-mismatch error', () => {
  assert.throws(
    () => assertTransactionInvariants({ outflow: 100, cashFlow: 'R-ALTRO' }),
    /Direction\/category mismatch/,
  );
});

test('unknown category prefix throws', () => {
  assert.throws(
    () =>
      assertTransactionInvariants({
        outflow: 100,
        cashFlow: /** @type {any} */ ('X-WHATEVER'),
      }),
    /expected C- or R- prefix/,
  );
});

test('types: a non-CashFlowCategory string is rejected at compile time', () => {
  // Runtime throws (defense in depth); the type system also rejects this at
  // compile time, which is what makes this a *types* test rather than a
  // behavior test.
  assert.throws(() => {
    // @ts-expect-error — cashFlow must match `C-${string}` | `R-${string}` | '' | null.
    assertTransactionInvariants({ outflow: 100, cashFlow: 'WRONG-PREFIX' });
  });
});

test('unknown category (correct prefix, not in map) throws', () => {
  assert.throws(
    () => assertTransactionInvariants({ outflow: 100, cashFlow: 'C-NOT-IN-MAP' }),
    /Unknown cash flow category/,
  );
});

test('missing cashFlow is allowed (unclassified row)', () => {
  assertTransactionInvariants({ inflow: 100 });
  assertTransactionInvariants({ outflow: 100 });
  assertTransactionInvariants({});
});

test('empty-string cashFlow is allowed (treated as unclassified)', () => {
  assertTransactionInvariants({ inflow: 100, cashFlow: '' });
});

test('zero-value inflow and outflow with C- category is allowed (no direction violation)', () => {
  assertTransactionInvariants({ inflow: 0, outflow: 0, cashFlow: 'C-SPESE EXTRA' });
});

test('null-value money fields with valid category are allowed', () => {
  assertTransactionInvariants({ inflow: null, outflow: 100, cashFlow: 'C-SPESE EXTRA' });
});
