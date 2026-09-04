// Consolidated Documents section tests (filter / export / recipients) — maps
// to docs/specs/cashflow-documents-filter-export-spec.md.
//
// Merged from: attachments-filter.test.js, attachments-export.test.js,
// attachments-recipients.test.js.
//
// NOTE: test.mock.module is per-process and applies file-wide. The source
// files mocked config.js with DIFFERENT listBankingYears values, so the mock
// below reads mutable stub state (currentBankingYears) which each describe
// block sets in a before() hook.

import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import JSZip from 'jszip';

const testRoot = await mkdtemp(join(tmpdir(), 'gd-documents-filter-export-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;
// GL_STORE is pinned to 'json': these seed the JSON sidecar directly, which the
// store branch of /search, /recipients and /export bypasses entirely. Their
// store path is covered by tests/attachment-relocation-store.test.js. Both pins
// go away at T18, when the JSON path is removed.
process.env.GL_STORE = 'json';

// Mutable stub state — each describe block sets the banking years its
// original source file mocked.
let currentBankingYears = ['2026', '2027'];

test.mock.module('../config.js', {
  namedExports: {
    MONTHS: ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'],
    listBankingYears: async () => currentBankingYears,
    getDataDir: () => testRoot,
  },
});

test.mock.module('../services/banking.js', {
  namedExports: {
    readTransactions: async () => [],
  },
});

const { setAttachment } = await import('../services/transactionAttachments.js');
const { updateSettings } = await import('../services/settings.js');
const { default: attachmentsRouter } = await import('../routes/attachments.js');

const baseRecord = {
  mimeType: 'application/pdf',
  size: 10,
  linkedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'present',
  lastVerifiedAt: '2026-01-01T00:00:00.000Z',
  storageMode: 'uploaded',
};

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

// seed: optional async function run before the server starts.
// withRoot: true → fresh attachmentRoot; false → attachmentRoot cleared;
// undefined → settings untouched.
async function startServer({ seed, withRoot } = {}) {
  if (seed) await seed();
  let attachmentRoot = null;
  if (withRoot === true) {
    attachmentRoot = await mkdtemp(join(testRoot, 'root-'));
    updateSettings({ attachmentRoot });
  } else if (withRoot === false) {
    updateSettings({ attachmentRoot: '' });
  }
  const app = express();
  app.use(express.json());
  app.use('/api/attachments', attachmentsRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, attachmentRoot });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

describe('GET /api/attachments/search — filters', () => {
  before(() => {
    currentBankingYears = ['2026', '2027'];
  });

  async function seedAttachments() {
    await setAttachment('2026', 'APR', 10, {
      ...baseRecord,
      relativePath: '2026/ACME SRL/20260410 - ACME SRL.pdf',
      fileName: '20260410 - ACME SRL.pdf',
      originalFileName: 'invoice.pdf',
    });
    await setAttachment('2026', 'APR', 11, {
      ...baseRecord,
      relativePath: '2026/BETA SPA/20260415 - BETA SPA.pdf',
      fileName: '20260415 - BETA SPA.pdf',
      originalFileName: 'receipt.pdf',
    });
    await setAttachment('2026', 'MAG', 12, {
      ...baseRecord,
      relativePath: '2026/ACME SRL/20260505 - ACME SRL.pdf',
      fileName: '20260505 - ACME SRL.pdf',
      originalFileName: 'invoice.pdf',
    });
    await setAttachment('2027', 'GEN', 3, {
      ...baseRecord,
      relativePath: '2027/GAMMA LTD/20270110 - GAMMA LTD.pdf',
      fileName: '20270110 - GAMMA LTD.pdf',
      originalFileName: 'x.pdf',
    });
  }

  test('GET /search returns each item with a date field parsed from fileName', async () => {
    const { server, baseUrl } = await startServer({ seed: seedAttachments });
    try {
      const res = await fetch(`${baseUrl}/api/attachments/search`);
      assert.equal(res.status, 200);
      const body = await res.json();
      const apr10 = body.items.find((i) => i.year === 2026 && i.month === 'APR' && i.row === 10);
      assert.ok(apr10, 'apr10 item should be present');
      assert.equal(apr10.date, '2026-04-10');
      assert.equal(apr10.recipient, 'ACME SRL');
    } finally {
      await stopServer(server);
    }
  });

  test('GET /search?year=2026 scopes results to that year', async () => {
    const { server, baseUrl } = await startServer({ seed: seedAttachments });
    try {
      const res = await fetch(`${baseUrl}/api/attachments/search?year=2026`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.items.length > 0);
      assert.ok(body.items.every((i) => i.year === 2026), 'all items should be year 2026');
    } finally {
      await stopServer(server);
    }
  });

  test('GET /search?year=2026&month=APR narrows to that month', async () => {
    const { server, baseUrl } = await startServer({ seed: seedAttachments });
    try {
      const res = await fetch(`${baseUrl}/api/attachments/search?year=2026&month=APR`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.items.length, 2);
      assert.ok(body.items.every((i) => i.month === 'APR'));
    } finally {
      await stopServer(server);
    }
  });

  test('GET /search?recipient=acme%20srl matches case-insensitively', async () => {
    const { server, baseUrl } = await startServer({ seed: seedAttachments });
    try {
      const res = await fetch(`${baseUrl}/api/attachments/search?recipient=acme%20srl`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.items.length, 2);
      assert.ok(body.items.every((i) => i.recipient === 'ACME SRL'));
    } finally {
      await stopServer(server);
    }
  });

  test('GET /search dateFrom and dateTo are inclusive bounds on the parsed date', async () => {
    const { server, baseUrl } = await startServer({ seed: seedAttachments });
    try {
      const res = await fetch(`${baseUrl}/api/attachments/search?dateFrom=2026-04-10&dateTo=2026-04-15`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.items.length, 2);
      const dates = body.items.map((i) => i.date).sort();
      assert.deepEqual(dates, ['2026-04-10', '2026-04-15']);
    } finally {
      await stopServer(server);
    }
  });

  test('GET /search combines month + recipient + dateFrom filters with AND', async () => {
    const { server, baseUrl } = await startServer({ seed: seedAttachments });
    try {
      const res = await fetch(`${baseUrl}/api/attachments/search?year=2026&month=APR&recipient=ACME%20SRL&dateFrom=2026-04-01`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.items.length, 1);
      assert.equal(body.items[0].row, 10);
    } finally {
      await stopServer(server);
    }
  });

  test('GET /search with invalid month returns 422', async () => {
    const { server, baseUrl } = await startServer({ seed: seedAttachments });
    try {
      const res = await fetch(`${baseUrl}/api/attachments/search?month=XXX`);
      assert.equal(res.status, 422);
    } finally {
      await stopServer(server);
    }
  });

  test('GET /search with invalid dateFrom format returns 422', async () => {
    const { server, baseUrl } = await startServer({ seed: seedAttachments });
    try {
      const res = await fetch(`${baseUrl}/api/attachments/search?dateFrom=not-a-date`);
      assert.equal(res.status, 422);
    } finally {
      await stopServer(server);
    }
  });

  test('GET /search with q still works (regression)', async () => {
    const { server, baseUrl } = await startServer({ seed: seedAttachments });
    try {
      const res = await fetch(`${baseUrl}/api/attachments/search?q=gamma`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.items.length, 1);
      assert.equal(body.items[0].recipient, 'GAMMA LTD');
    } finally {
      await stopServer(server);
    }
  });

  test('GET /search dateFrom after dateTo returns empty results', async () => {
    const { server, baseUrl } = await startServer({ seed: seedAttachments });
    try {
      const res = await fetch(`${baseUrl}/api/attachments/search?dateFrom=2026-05-01&dateTo=2026-04-01`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.items, []);
    } finally {
      await stopServer(server);
    }
  });
});

describe('POST /api/attachments/export', () => {
  before(() => {
    currentBankingYears = ['2026'];
  });

  const exportRecord = {
    ...baseRecord,
    originalFileName: 'invoice.pdf',
  };

  async function writeFileUnderRoot(root, relativePath, content) {
    await mkdir(join(root, relativePath, '..'), { recursive: true });
    await writeFile(join(root, relativePath), content);
  }

  test('POST /export bundles requested items into a zip at destinationPath', async () => {
    const { server, baseUrl, attachmentRoot } = await startServer({ withRoot: true });
    try {
      const rel1 = '2026/ACME SRL/20260410 - ACME SRL.pdf';
      const rel2 = '2026/BETA SPA/20260415 - BETA SPA.pdf';
      await writeFileUnderRoot(attachmentRoot, rel1, 'acme-bytes');
      await writeFileUnderRoot(attachmentRoot, rel2, 'beta-bytes');

      await setAttachment('2026', 'APR', 10, { ...exportRecord, relativePath: rel1, fileName: '20260410 - ACME SRL.pdf' });
      await setAttachment('2026', 'APR', 11, { ...exportRecord, relativePath: rel2, fileName: '20260415 - BETA SPA.pdf' });

      const destDir = await mkdtemp(join(testRoot, 'dest-'));
      const destinationPath = join(destDir, 'documents.zip');

      const res = await fetch(`${baseUrl}/api/attachments/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            { year: 2026, month: 'APR', row: 10 },
            { year: 2026, month: 'APR', row: 11 },
          ],
          destinationPath,
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.exported, 2);
      assert.equal(body.skipped, 0);
      assert.equal(body.path, destinationPath);

      const zipBuffer = await readFile(destinationPath);
      const zip = await JSZip.loadAsync(zipBuffer);
      const names = Object.keys(zip.files).sort();
      assert.equal(names.length, 2);
      assert.match(names[0], /^2026-APR-ACME SRL-invoice\.pdf$/);
      assert.match(names[1], /^2026-APR-BETA SPA-invoice\.pdf$/);
    } finally {
      await stopServer(server);
    }
  });

  test('POST /export skips missing files and returns the skipped count', async () => {
    const { server, baseUrl, attachmentRoot } = await startServer({ withRoot: true });
    try {
      const present = '2026/ACME SRL/20260410 - ACME SRL.pdf';
      const missingRel = '2026/BETA SPA/20260415 - BETA SPA.pdf';
      await writeFileUnderRoot(attachmentRoot, present, 'bytes');

      await setAttachment('2026', 'APR', 10, { ...exportRecord, relativePath: present, fileName: '20260410 - ACME SRL.pdf' });
      await setAttachment('2026', 'APR', 11, { ...exportRecord, relativePath: missingRel, fileName: '20260415 - BETA SPA.pdf' });

      const destDir = await mkdtemp(join(testRoot, 'dest-'));
      const destinationPath = join(destDir, 'documents.zip');

      const res = await fetch(`${baseUrl}/api/attachments/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            { year: 2026, month: 'APR', row: 10 },
            { year: 2026, month: 'APR', row: 11 },
          ],
          destinationPath,
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.exported, 1);
      assert.equal(body.skipped, 1);
    } finally {
      await stopServer(server);
    }
  });

  test('POST /export skips external records', async () => {
    const { server, baseUrl, attachmentRoot } = await startServer({ withRoot: true });
    try {
      const rel = '2026/ACME SRL/20260410 - ACME SRL.pdf';
      await writeFileUnderRoot(attachmentRoot, rel, 'bytes');

      await setAttachment('2026', 'APR', 10, { ...exportRecord, relativePath: rel, fileName: '20260410 - ACME SRL.pdf' });
      await setAttachment('2026', 'APR', 11, {
        ...exportRecord,
        storageMode: 'external',
        absolutePath: '/nonexistent/absolute/path.pdf',
        fileName: 'external.pdf',
      });

      const destDir = await mkdtemp(join(testRoot, 'dest-'));
      const destinationPath = join(destDir, 'documents.zip');

      const res = await fetch(`${baseUrl}/api/attachments/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            { year: 2026, month: 'APR', row: 10 },
            { year: 2026, month: 'APR', row: 11 },
          ],
          destinationPath,
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.exported, 1);
      assert.equal(body.skipped, 1);
    } finally {
      await stopServer(server);
    }
  });

  test('POST /export suffixes -2, -3 on zip entry name collisions', async () => {
    const { server, baseUrl, attachmentRoot } = await startServer({ withRoot: true });
    try {
      // Two records sharing the exact same year / month / recipient / originalFileName → collision
      const relA = '2026/ACME SRL/20260410 - ACME SRL.pdf';
      const relB = '2026/ACME SRL/20260411 - ACME SRL.pdf';
      await writeFileUnderRoot(attachmentRoot, relA, 'a');
      await writeFileUnderRoot(attachmentRoot, relB, 'b');

      await setAttachment('2026', 'APR', 10, { ...exportRecord, relativePath: relA, fileName: '20260410 - ACME SRL.pdf', originalFileName: 'invoice.pdf' });
      await setAttachment('2026', 'APR', 11, { ...exportRecord, relativePath: relB, fileName: '20260411 - ACME SRL.pdf', originalFileName: 'invoice.pdf' });

      const destDir = await mkdtemp(join(testRoot, 'dest-'));
      const destinationPath = join(destDir, 'documents.zip');

      const res = await fetch(`${baseUrl}/api/attachments/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            { year: 2026, month: 'APR', row: 10 },
            { year: 2026, month: 'APR', row: 11 },
          ],
          destinationPath,
        }),
      });
      assert.equal(res.status, 200);

      const zipBuffer = await readFile(destinationPath);
      const zip = await JSZip.loadAsync(zipBuffer);
      const names = Object.keys(zip.files).sort();
      assert.equal(names.length, 2);
      assert.equal(names[0], '2026-APR-ACME SRL-invoice-2.pdf');
      assert.equal(names[1], '2026-APR-ACME SRL-invoice.pdf');
    } finally {
      await stopServer(server);
    }
  });

  test('POST /export rejects requests with more than 100 items (422)', async () => {
    const { server, baseUrl } = await startServer({ withRoot: true });
    try {
      const destDir = await mkdtemp(join(testRoot, 'dest-'));
      const destinationPath = join(destDir, 'documents.zip');
      const items = Array.from({ length: 101 }, (_, i) => ({ year: 2026, month: 'APR', row: 10 + i }));

      const res = await fetch(`${baseUrl}/api/attachments/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, destinationPath }),
      });
      assert.equal(res.status, 422);
      const body = await res.json();
      assert.match(body.error, /limit|100/i);
    } finally {
      await stopServer(server);
    }
  });

  test('POST /export rejects a non-absolute destinationPath (422)', async () => {
    const { server, baseUrl } = await startServer({ withRoot: true });
    try {
      const res = await fetch(`${baseUrl}/api/attachments/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ year: 2026, month: 'APR', row: 10 }],
          destinationPath: 'relative/path.zip',
        }),
      });
      assert.equal(res.status, 422);
      const body = await res.json();
      assert.match(body.error, /absolute|destination/i);
    } finally {
      await stopServer(server);
    }
  });

  test('POST /export rejects empty items list (400)', async () => {
    const { server, baseUrl } = await startServer({ withRoot: true });
    try {
      const destDir = await mkdtemp(join(testRoot, 'dest-empty-'));
      const destinationPath = join(destDir, 'documents.zip');
      const res = await fetch(`${baseUrl}/api/attachments/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [], destinationPath }),
      });
      assert.equal(res.status, 400);
    } finally {
      await stopServer(server);
    }
  });

  test('POST /export rejects a destinationPath that does not end in .zip (422)', async () => {
    const { server, baseUrl } = await startServer({ withRoot: true });
    try {
      const destDir = await mkdtemp(join(testRoot, 'dest-wrong-ext-'));
      const destinationPath = join(destDir, 'documents.txt');
      const res = await fetch(`${baseUrl}/api/attachments/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ year: 2026, month: 'APR', row: 10 }],
          destinationPath,
        }),
      });
      assert.equal(res.status, 422);
      const body = await res.json();
      assert.match(body.error, /\.zip/);
    } finally {
      await stopServer(server);
    }
  });

  test('POST /export skips malformed items silently', async () => {
    const { server, baseUrl, attachmentRoot } = await startServer({ withRoot: true });
    try {
      const rel = '2026/ACME SRL/20260410 - ACME SRL.pdf';
      await writeFileUnderRoot(attachmentRoot, rel, 'bytes');
      await setAttachment('2026', 'APR', 10, { ...exportRecord, relativePath: rel, fileName: '20260410 - ACME SRL.pdf' });

      const destDir = await mkdtemp(join(testRoot, 'dest-malformed-'));
      const destinationPath = join(destDir, 'documents.zip');

      const res = await fetch(`${baseUrl}/api/attachments/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            { year: 2026, month: 'APR', row: 10 },
            { year: null, month: 'APR', row: 10 },
            { year: 2026, month: 'XXX', row: 10 },
            { year: 2026, month: 'APR', row: 'not-a-number' },
          ],
          destinationPath,
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.exported, 1);
      assert.equal(body.skipped, 3);
    } finally {
      await stopServer(server);
    }
  });

  test('POST /export returns 422 when attachmentRoot is not configured', async () => {
    const { server, baseUrl } = await startServer({ withRoot: false });
    try {
      const destDir = await mkdtemp(join(testRoot, 'dest-no-root-'));
      const destinationPath = join(destDir, 'documents.zip');
      const res = await fetch(`${baseUrl}/api/attachments/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ year: 2026, month: 'APR', row: 10 }],
          destinationPath,
        }),
      });
      assert.equal(res.status, 422);
      const body = await res.json();
      assert.match(body.error, /attachment root/i);
    } finally {
      await stopServer(server);
    }
  });

  test('POST /export returns 500 with a path-free message when writeFile fails', async () => {
    const { server, baseUrl, attachmentRoot } = await startServer({ withRoot: true });
    try {
      const rel = '2026/ACME SRL/20260410 - ACME SRL.pdf';
      await writeFileUnderRoot(attachmentRoot, rel, 'bytes');
      await setAttachment('2026', 'APR', 10, { ...exportRecord, relativePath: rel, fileName: '20260410 - ACME SRL.pdf' });

      // A path that cannot be written: write target is inside a regular file, not a directory
      const badDir = await mkdtemp(join(testRoot, 'bad-dest-'));
      const blocker = join(badDir, 'documents.zip');
      await writeFile(blocker, 'existing', 'utf8'); // will be overwritten; use a nested path instead
      const destinationPath = join(blocker, 'nested.zip');

      const res = await fetch(`${baseUrl}/api/attachments/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ year: 2026, month: 'APR', row: 10 }],
          destinationPath,
        }),
      });
      assert.equal(res.status, 500);
      const body = await res.json();
      // Must not leak the absolute path
      assert.equal(body.error.includes(destinationPath), false);
      assert.match(body.error, /unable to write/i);
    } finally {
      await stopServer(server);
    }
  });
});

describe('GET /api/attachments/recipients', () => {
  before(() => {
    currentBankingYears = ['2026', '2027'];
  });

  async function seed() {
    // Year 2026: ACME SRL twice (dedupe), BETA SPA once
    await setAttachment('2026', 'APR', 10, {
      ...baseRecord,
      relativePath: '2026/ACME SRL/20260410 - ACME SRL.pdf',
      fileName: '20260410 - ACME SRL.pdf',
      originalFileName: 'a.pdf',
    });
    await setAttachment('2026', 'APR', 11, {
      ...baseRecord,
      relativePath: '2026/acme srl/20260415 - acme srl.pdf', // different case — should dedupe
      fileName: '20260415 - acme srl.pdf',
      originalFileName: 'a.pdf',
    });
    await setAttachment('2026', 'MAG', 12, {
      ...baseRecord,
      relativePath: '2026/BETA SPA/20260505 - BETA SPA.pdf',
      fileName: '20260505 - BETA SPA.pdf',
      originalFileName: 'b.pdf',
    });
    // External record — has no recipient-derivable path → must be excluded
    await setAttachment('2026', 'GIU', 13, {
      ...baseRecord,
      storageMode: 'external',
      absolutePath: '/Volumes/X/external.pdf',
      fileName: 'external.pdf',
      originalFileName: 'external.pdf',
    });
    // Year 2027: DELTA LTD (not returned when year=2026 scope)
    await setAttachment('2027', 'GEN', 3, {
      ...baseRecord,
      relativePath: '2027/DELTA LTD/20270110 - DELTA LTD.pdf',
      fileName: '20270110 - DELTA LTD.pdf',
      originalFileName: 'x.pdf',
    });
  }

  test('GET /recipients?year=2026 returns distinct sorted recipients for that year', async () => {
    const { server, baseUrl } = await startServer({ seed });
    try {
      const res = await fetch(`${baseUrl}/api/attachments/recipients?year=2026`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.recipients, ['ACME SRL', 'BETA SPA']);
    } finally {
      await stopServer(server);
    }
  });

  test('GET /recipients without year returns 422', async () => {
    const { server, baseUrl } = await startServer({ seed });
    try {
      const res = await fetch(`${baseUrl}/api/attachments/recipients`);
      assert.equal(res.status, 422);
    } finally {
      await stopServer(server);
    }
  });

  test('GET /recipients?year=9999 returns an empty array when no attachments exist', async () => {
    const { server, baseUrl } = await startServer({ seed });
    try {
      const res = await fetch(`${baseUrl}/api/attachments/recipients?year=9999`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.recipients, []);
    } finally {
      await stopServer(server);
    }
  });
});
