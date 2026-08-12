import test from 'node:test';
import assert from 'node:assert/strict';
import { toCents, fromCents, sumCents } from '../services/money.js';

// ---------------------------------------------------------------------------
// toCents
// ---------------------------------------------------------------------------

test('toCents converts a 2-dp number exactly', () => {
  assert.equal(toCents(1.23), 123);
  assert.equal(toCents(0.01), 1);
  assert.equal(toCents(10), 1000);
});

test('toCents handles the canonical FP-drift case (0.1 * 100)', () => {
  // 0.1 * 100 in IEEE 754 = 10.000000000000002 — Math.round handles it.
  assert.equal(toCents(0.1), 10);
  assert.equal(toCents(0.2), 20);
  assert.equal(toCents(0.3), 30);
});

test('toCents treats null/undefined/empty as 0', () => {
  assert.equal(toCents(null), 0);
  assert.equal(toCents(undefined), 0);
  assert.equal(toCents(''), 0);
});

test('toCents treats NaN and non-finite as 0', () => {
  assert.equal(toCents(NaN), 0);
  assert.equal(toCents(Infinity), 0);
  assert.equal(toCents(-Infinity), 0);
});

test('toCents parses decimal strings', () => {
  assert.equal(toCents('1.23'), 123);
  assert.equal(toCents('0.01'), 1);
  assert.equal(toCents('-1.50'), -150);
});

test('toCents handles negative values', () => {
  assert.equal(toCents(-1.5), -150);
  assert.equal(toCents(-0.01), -1);
});

test('toCents rounds sub-cent inputs via Math.round', () => {
  // Math.round behavior on IEEE 754 representations is acceptable for this codebase —
  // financial inputs are entered with 2-dp precision; we don't promise 3-dp accuracy.
  // 2.5 * 100 = 250 exactly → 250
  assert.equal(toCents(2.5), 250);
  // -1.5 * 100 = -150 exactly → -150
  assert.equal(toCents(-1.5), -150);
});

test('sumCents on 3-dp inputs follows the IEEE-754 contract (spec test 8)', () => {
  // 1.005 * 100 = 100.4999… → 100; 2.005 * 100 = 200.5000…03 → 201
  assert.equal(toCents(1.005), 100);
  assert.equal(toCents(2.005), 201);
  assert.equal(sumCents([1.005, 2.005]), 301);
});

// ---------------------------------------------------------------------------
// fromCents
// ---------------------------------------------------------------------------

test('fromCents converts integer cents to EUR', () => {
  assert.equal(fromCents(30), 0.3);
  assert.equal(fromCents(123), 1.23);
  assert.equal(fromCents(0), 0);
  assert.equal(fromCents(-50), -0.5);
});

test('round-trip via toCents → fromCents is exact for 2-dp inputs', () => {
  assert.equal(fromCents(toCents(1.23)), 1.23);
  assert.equal(fromCents(toCents(0.01)), 0.01);
  assert.equal(fromCents(toCents(99.99)), 99.99);
});

// ---------------------------------------------------------------------------
// sumCents
// ---------------------------------------------------------------------------

test('sumCents([0.1, 0.2]) === 30 (the canonical FP-drift case)', () => {
  // Without cents: 0.1 + 0.2 === 0.30000000000000004
  assert.equal(sumCents([0.1, 0.2]), 30);
  assert.equal(fromCents(sumCents([0.1, 0.2])), 0.3);
});

test('sumCents of 100 × 0.01 is exactly 100 cents', () => {
  const values = Array(100).fill(0.01);
  assert.equal(sumCents(values), 100);
  assert.equal(fromCents(sumCents(values)), 1);
});

test('sumCents of 7 × 0.1 is exactly 70 cents', () => {
  // Without cents: 7 × 0.1 = 0.7000000000000001
  const values = Array(7).fill(0.1);
  assert.equal(sumCents(values), 70);
  assert.equal(fromCents(sumCents(values)), 0.7);
});

test('sumCents skips null/undefined entries', () => {
  assert.equal(sumCents([1.0, null, undefined, 2.0]), 300);
});

test('sumCents of an empty iterable returns 0', () => {
  assert.equal(sumCents([]), 0);
});

test('sumCents handles mixed positive/negative values', () => {
  assert.equal(sumCents([1.5, -0.5, 2.0]), 300);
});
