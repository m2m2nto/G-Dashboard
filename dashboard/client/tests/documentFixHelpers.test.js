import test from 'node:test';
import assert from 'node:assert/strict';
import { relinkDocumentAttachment } from '../src/documentFixHelpers.js';

const item = { year: 2026, month: 'APR', row: 12 };
const payload = { relativePath: '2026/ACME SRL/correct.pdf', absolutePath: undefined, destinationFolder: null };

test('relinkDocumentAttachment — attaches with replace:true using the row coordinates', async () => {
  const calls = [];
  const result = await relinkDocumentAttachment(item, payload, {
    attach: async (year, month, row, body) => {
      calls.push(['attach', year, month, row, body]);
      return { mode: 'link' };
    },
    verify: async () => {
      calls.push(['verify']);
    },
  });

  assert.deepEqual(calls[0], ['attach', 2026, 'APR', 12, { ...payload, replace: true }]);
  assert.deepEqual(calls[1], ['verify']);
  assert.deepEqual(result, { mode: 'link' });
});

test('relinkDocumentAttachment — verification failure does not fail the relink', async () => {
  const result = await relinkDocumentAttachment(item, payload, {
    attach: async () => ({ mode: 'link' }),
    verify: async () => {
      throw new Error('verify exploded');
    },
  });
  assert.deepEqual(result, { mode: 'link' });
});

test('relinkDocumentAttachment — attach failure propagates and verify never runs', async () => {
  let verifyCalled = false;
  await assert.rejects(
    relinkDocumentAttachment(item, payload, {
      attach: async () => {
        throw new Error('409 already attached');
      },
      verify: async () => {
        verifyCalled = true;
      },
    }),
    /409/,
  );
  assert.equal(verifyCalled, false);
});
