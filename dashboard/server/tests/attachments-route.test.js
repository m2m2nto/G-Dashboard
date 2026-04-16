import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAttachmentSearchItems } from '../routes/attachments.js';

test('buildAttachmentSearchItems shapes search rows with transaction recipient data', () => {
  const items = buildAttachmentSearchItems('2026', {
    'APR-12': {
      relativePath: '2026/ACME SRL/20260410 - ACME SRL.pdf',
      fileName: '20260410 - ACME SRL.pdf',
      status: 'present',
      storageMode: 'uploaded',
      lastVerifiedAt: '2026-04-12T10:16:00.000Z',
    },
  }, {
    'APR-12': {
      row: 12,
      transaction: 'ACME SRL',
    },
  });

  assert.deepEqual(items, [
    {
      year: 2026,
      month: 'APR',
      row: 12,
      recipient: 'ACME SRL',
      fileName: '20260410 - ACME SRL.pdf',
      relativePath: '2026/ACME SRL/20260410 - ACME SRL.pdf',
      status: 'present',
      storageMode: 'uploaded',
      lastVerifiedAt: '2026-04-12T10:16:00.000Z',
    },
  ]);
});

test('buildAttachmentSearchItems falls back to empty recipient when the row cannot be resolved', () => {
  const items = buildAttachmentSearchItems('2026', {
    'MAG-7': {
      relativePath: '2026/missing/file.pdf',
      fileName: 'file.pdf',
      status: 'missing',
      storageMode: 'linked',
      lastVerifiedAt: null,
    },
  }, {});

  assert.equal(items[0].recipient, '');
  assert.equal(items[0].month, 'MAG');
  assert.equal(items[0].row, 7);
});
