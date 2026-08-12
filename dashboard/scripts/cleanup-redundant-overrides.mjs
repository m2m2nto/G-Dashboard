#!/usr/bin/env node
// One-off cleanup script.
//
// Removes Budget Category Override entries that just duplicate what the global
// CF -> Budget Mapping would resolve. Backs up the override file before writing.
//
// Usage:
//   node scripts/cleanup-redundant-overrides.mjs <year> [--apply]
//
// Without --apply it runs as a dry-run and prints what would be removed.

import { readFile, writeFile, copyFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { readTransactions } from '../server/services/banking.js';
import { getProjectDir } from '../server/services/project.js';
import { MONTHS } from '../server/config.js';

const args = process.argv.slice(2);
const year = args.find((a) => /^\d{4}$/.test(a)) || '2026';
const apply = args.includes('--apply');

const projectDir = getProjectDir();
if (!projectDir) {
  console.error('No project loaded — settings.json must point at a valid project.');
  process.exit(1);
}

const overrideFile = join(projectDir, '.gl-data', `transaction-budget-map-${year}.json`);
const mappingFile = join(projectDir, '.gl-data', 'cf-budget-category-map.json');

const overrideMap = JSON.parse(await readFile(overrideFile, 'utf8'));
const cfMap = JSON.parse(await readFile(mappingFile, 'utf8'));

const cfByKey = new Map();
for (const month of MONTHS) {
  let rows;
  try {
    rows = await readTransactions(month, year);
  } catch (err) {
    console.warn(`Skipping ${month}: ${err.message}`);
    continue;
  }
  for (const tx of rows) {
    cfByKey.set(`${month}-${tx.row}`, tx.cashFlow || null);
  }
}

const redundant = [];
const keptDivergent = [];
const keptUnmapped = [];
const keptNoTx = [];

for (const [key, entry] of Object.entries(overrideMap)) {
  const cf = cfByKey.has(key) ? cfByKey.get(key) : undefined;
  if (cf === undefined) {
    keptNoTx.push({ key, entry });
    continue;
  }
  if (!cf) {
    keptUnmapped.push({ key, entry, reason: 'transaction has no CF Category' });
    continue;
  }
  const mapped = cfMap[cf];
  if (!mapped) {
    keptUnmapped.push({ key, entry, reason: `CF Category "${cf}" not in Mapping` });
    continue;
  }
  if (mapped.budgetCategory === entry.category && mapped.budgetRow === entry.budgetRow) {
    redundant.push({ key, entry, cf });
  } else {
    keptDivergent.push({ key, entry, cf, mapped });
  }
}

console.log(`Year: ${year}`);
console.log(`Total Override entries: ${Object.keys(overrideMap).length}`);
console.log(`  Redundant (would delete): ${redundant.length}`);
console.log(`  Kept — divergent from Mapping: ${keptDivergent.length}`);
console.log(`  Kept — CF Category unmapped or empty: ${keptUnmapped.length}`);
console.log(`  Kept — Transaction row not found in Banking: ${keptNoTx.length}`);
console.log();

if (keptDivergent.length) {
  console.log('Genuine Overrides (different from Mapping):');
  for (const { key, entry, cf, mapped } of keptDivergent) {
    console.log(
      `  ${key}: CF="${cf}" -> Override="${entry.category}"/${entry.budgetRow}` +
        ` (Mapping would resolve to "${mapped.budgetCategory}"/${mapped.budgetRow})`,
    );
  }
  console.log();
}

if (keptUnmapped.length) {
  console.log('Kept because not derivable from Mapping:');
  for (const { key, entry, reason } of keptUnmapped) {
    console.log(`  ${key}: "${entry.category}"/${entry.budgetRow} — ${reason}`);
  }
  console.log();
}

if (keptNoTx.length) {
  console.log('Kept because Transaction row not found (possibly stale):');
  for (const { key, entry } of keptNoTx) {
    console.log(`  ${key}: "${entry.category}"/${entry.budgetRow}`);
  }
  console.log();
}

if (!apply) {
  console.log('Dry-run only. Re-run with --apply to write the trimmed file.');
  process.exit(0);
}

if (redundant.length === 0) {
  console.log('Nothing to remove. File unchanged.');
  process.exit(0);
}

const backupDir = join(projectDir, '.gl-data', 'backup');
await mkdir(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupFile = join(backupDir, `transaction-budget-map-${year}.${stamp}.json`);
await copyFile(overrideFile, backupFile);
console.log(`Backup written: ${backupFile}`);

const trimmed = { ...overrideMap };
for (const { key } of redundant) delete trimmed[key];

await writeFile(overrideFile, JSON.stringify(trimmed, null, 2), 'utf8');
console.log(`Wrote ${Object.keys(trimmed).length} entries to ${overrideFile} (removed ${redundant.length}).`);
