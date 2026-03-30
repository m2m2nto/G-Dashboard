import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { assertNotOpenInExcel } from '../services/excel.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), `gl-dashboard-test-${Date.now()}`);
const EXCEL_FILE = join(TEST_DIR, 'Budget 2026.xlsx');

async function createFile(path, content = '') {
  await writeFile(path, content);
}

async function removeFile(path) {
  try { await unlink(path); } catch { /* ignore if not exists */ }
}

// ---------------------------------------------------------------------------
// Lock-file detection tests
// ---------------------------------------------------------------------------

describe('assertNotOpenInExcel', () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    // Create a dummy Excel file
    await createFile(EXCEL_FILE, 'dummy');
  });

  after(async () => {
    // Clean up test directory
    const { rm } = await import('fs/promises');
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('passes when no lock file exists and file is not open', async () => {
    // Should not throw
    await assertNotOpenInExcel(EXCEL_FILE);
  });

  it('blocks when MS Excel lock file (~$) exists', async () => {
    const lockFile = join(TEST_DIR, '~$Budget 2026.xlsx');
    await createFile(lockFile);
    try {
      await assert.rejects(
        () => assertNotOpenInExcel(EXCEL_FILE),
        { message: /Cannot complete the operation.*currently open/ }
      );
    } finally {
      await removeFile(lockFile);
    }
  });

  it('blocks when MS Excel truncated lock file (~$ with first 2 chars dropped) exists', async () => {
    const lockFile = join(TEST_DIR, '~$dget 2026.xlsx');
    await createFile(lockFile);
    try {
      await assert.rejects(
        () => assertNotOpenInExcel(EXCEL_FILE),
        { message: /Cannot complete the operation.*currently open/ }
      );
    } finally {
      await removeFile(lockFile);
    }
  });

  it('blocks when LibreOffice lock file (.~lock.) exists', async () => {
    const lockFile = join(TEST_DIR, '.~lock.Budget 2026.xlsx#');
    await createFile(lockFile);
    try {
      await assert.rejects(
        () => assertNotOpenInExcel(EXCEL_FILE),
        { message: /Cannot complete the operation.*currently open/ }
      );
    } finally {
      await removeFile(lockFile);
    }
  });

  it('does NOT block when non-spreadsheet process has file open (e.g. OneDrive)', async () => {
    // lsof on a file opened only by non-spreadsheet apps should pass
    // We test this by checking the file we just created — only our node process has it,
    // and "node" is not in the SPREADSHEET_APPS list
    await assertNotOpenInExcel(EXCEL_FILE);
  });

  it('passes after lock file is removed (simulates closing Excel)', async () => {
    const lockFile = join(TEST_DIR, '~$Budget 2026.xlsx');
    await createFile(lockFile);

    // Should block
    await assert.rejects(
      () => assertNotOpenInExcel(EXCEL_FILE),
      { message: /Cannot complete the operation/ }
    );

    // Remove lock file (simulate closing Excel)
    await removeFile(lockFile);

    // Should pass now
    await assertNotOpenInExcel(EXCEL_FILE);
  });

  it('error message includes the file name', async () => {
    const lockFile = join(TEST_DIR, '~$Budget 2026.xlsx');
    await createFile(lockFile);
    try {
      await assert.rejects(
        () => assertNotOpenInExcel(EXCEL_FILE),
        { message: /Budget 2026\.xlsx/ }
      );
    } finally {
      await removeFile(lockFile);
    }
  });

  it('handles files with short names (< 2 chars)', async () => {
    const shortFile = join(TEST_DIR, 'X.xlsx');
    await createFile(shortFile);
    // Should not throw — no lock file, short name doesn't generate truncated candidate
    await assertNotOpenInExcel(shortFile);
    await removeFile(shortFile);
  });
});

// ---------------------------------------------------------------------------
// lsof filtering tests — verify SPREADSHEET_APPS matching logic
// ---------------------------------------------------------------------------

describe('lsof filtering logic', () => {
  // These test the SPREADSHEET_APPS matching logic directly
  const SPREADSHEET_APPS = ['excel', 'numbers', 'soffice', 'libreoffice', 'openoffice'];

  function isSpreadsheetProcess(command) {
    return SPREADSHEET_APPS.some((app) => command.toLowerCase().replace(/\\x20/g, ' ').includes(app));
  }

  it('detects Microsoft Excel', () => {
    assert.ok(isSpreadsheetProcess('Microsoft Excel'));
  });

  it('detects Microsoft Excel with lsof escaping (\\x20)', () => {
    assert.ok(isSpreadsheetProcess('Microsoft\\x20Excel'));
  });

  it('detects Numbers', () => {
    assert.ok(isSpreadsheetProcess('Numbers'));
  });

  it('detects LibreOffice (soffice)', () => {
    assert.ok(isSpreadsheetProcess('soffice.bin'));
  });

  it('detects LibreOffice (full name)', () => {
    assert.ok(isSpreadsheetProcess('libreoffice'));
  });

  it('detects OpenOffice', () => {
    assert.ok(isSpreadsheetProcess('openoffice'));
  });

  it('ignores OneDrive', () => {
    assert.ok(!isSpreadsheetProcess('OneDrive'));
  });

  it('ignores Finder', () => {
    assert.ok(!isSpreadsheetProcess('Finder'));
  });

  it('ignores node', () => {
    assert.ok(!isSpreadsheetProcess('node'));
  });

  it('ignores com.microsoft.OneDrive', () => {
    assert.ok(!isSpreadsheetProcess('com.microsoft.OneDrive'));
  });

  it('ignores Spotlight (mds_stores)', () => {
    assert.ok(!isSpreadsheetProcess('mds_stores'));
  });
});
