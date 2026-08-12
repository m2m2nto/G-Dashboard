# Spec: Atomic Excel Writes + Rotating Backups

> **Status:** Draft. Closes the in-place-mutation gap on the three Excel files (banking, cash flow, budget). No UI surface; pure infrastructure.

## Objective

Eliminate two risks in the current Excel write paths:

1. **Mid-write corruption.** Every `await wb.toFileAsync(filePath)` and `await writeFile(filePath, buf)` in the Excel services (formerly `services/excel.js`, since split into `services/banking.js`, `services/cashflow.js`, `services/budget.js`) writes the destination file directly. If the process crashes (OS kill, sudden power loss, hung lsof check) after the file is opened but before it's fully flushed, the destination is left truncated or partial. The workbook becomes unreadable.

2. **No recovery story.** Once a write commits, the previous version is gone. A buggy `updateElementCategory` (the recipient-decoupling incident) or a misclassified transaction leaves no easy roll-back. The audit log records that something changed; it doesn't store the bytes.

The fix combines two existing patterns from the codebase:

- **Atomic write** (already used by `services/transactionAttachments.js` for `.gl-data/transaction-attachments-{year}.json`): write to `<file>.tmp`, then `rename()` to the destination. POSIX `rename()` on the same filesystem is atomic.
- **Snapshot before write**: copy the existing file to `.gl-data/backup/<basename>.<ISO>.xlsx` before each high-level operation. Keep the latest N snapshots per file, prune older.

## Scope

In:
- All Excel write paths:
  - `addTransaction`, `updateTransaction`, `deleteTransaction`, `compactTable` (`server/services/banking.js`)
  - `syncAllCashFlow` (which `syncCashFlow` delegates to), `createElement`, `updateElementCategory` (`server/services/cashflow.js`)
  - `ensureBankingFile` (`server/services/banking.js`; the seed `copyFile` is atomic enough — only the post-copy `toFileAsync` needs the helper)
  - `updateBudgetConsuntivoBatch`, `updateBudgetScenarioBatch` (`server/services/budget.js`)

Out (deferred):
- JSON sidecars under `.gl-data/`. The attachment sidecar already uses temp+rename; budget-entries and others do not. Out of scope for v1; the audit log + cents-precision sidecar combo gives enough recovery for JSON.
- UI for browsing or restoring from backups. Restore is a manual `cp` for now.
- Off-machine backups (cloud, NAS).

## Tech Stack

- Node ESM. New helper `server/services/atomicWrite.js`.
- No new dependencies. Uses `fs/promises` (`rename`, `copyFile`, `readdir`, `unlink`, `mkdir`, `writeFile`).

## Helpers

`server/services/atomicWrite.js` exports:

```ts
/** Snapshot the existing file (if any) to .gl-data/backup/ and prune to keepCount. No-op if filePath doesn't exist yet. */
export async function snapshotExcelFile(filePath: string, opts?: { keepCount?: number }): Promise<{ snapshotPath: string | null, pruned: number }>;

/** Write buffer to <filePath>.tmp, then rename to filePath. Cleans up tmp on failure. */
export async function writeFileAtomic(filePath: string, buffer: Buffer | Uint8Array): Promise<void>;
```

Defaults: `keepCount = 5`.

Snapshot filename format: `<basename>.<ISO with `:` and `.` replaced by `-`>.xlsx`. Example:
`Banking transactions - Gulliver Lux 2026.2026-05-25T18-36-12-123Z.xlsx`

Rotation: list all snapshot files in `.gl-data/backup/` whose basename matches the current file's, sort by timestamp, delete everything older than the keepCount-th newest.

## Call Pattern

For each high-level write function in the Excel services:

```js
export async function addTransaction(month, data, year = '2026') {
  assertTransactionInvariants(data);
  const filePath = getBankingFile(year);
  await assertNotOpenInExcel(filePath);
  await snapshotExcelFile(filePath);     // ← NEW: one snapshot per operation
  return withLock(filePath, async () => {
    // … existing mutation logic …
    await writeFileAtomic(filePath, output);   // ← REPLACES inline writeFile
  });
}
```

`xlsx-populate`'s `wb.toFileAsync(filePath)` is replaced with:
```js
const buf = await wb.outputAsync();
await writeFileAtomic(filePath, buf);
```

Snapshots happen ONCE per high-level operation, before any writes. The intermediate two-write pattern (xlsx-populate write, then JSZip patch) is preserved internally; both writes are now atomic but no extra snapshots are taken. This avoids polluting the backup ring with intermediate states.

## Storage Model

- Backup directory: `<projectDir>/.gl-data/backup/` (project-local, not user-global).
- Filename: `<basename>.<sanitizedIso>.xlsx`.
- Rotation policy: keep the 5 newest per source file; prune older. Pruning is per source file, not global — banking and cash flow rotate independently.
- Disk cost estimate: 3 files × 5 snapshots × ~20-200 KB each ≈ 0.3-3 MB per project. Negligible.

The recommendation called out "~50-200 MB" — that was wrong. Real banking files in this repo are ~20-200 KB. Estimate revised.

## Tests

### Unit (`atomic-write.test.js`)

1. `writeFileAtomic` writes data and leaves no `.tmp` file behind on success.
2. `writeFileAtomic` cleans up `.tmp` if rename fails.
3. `writeFileAtomic` overwrites an existing target.
4. `snapshotExcelFile` is a no-op when source doesn't exist yet.
5. `snapshotExcelFile` copies the source under `.gl-data/backup/`.
6. `snapshotExcelFile` returns the snapshot path.
7. `snapshotExcelFile` prunes to `keepCount` snapshots per source file.
8. Multiple source files rotate independently.

### Integration (`excel-write-backup.test.js`)

1. A single `addTransaction` call produces exactly one snapshot.
2. Six successive `addTransaction` calls leave exactly 5 snapshots in the backup dir (oldest pruned).
3. The original file's content after `addTransaction` reflects the new row (atomic write doesn't lose data).
4. A simulated write failure (interrupt before rename) leaves the original file untouched.

## Boundaries

Always:
- Snapshot once at the start of each high-level operation, after the lock-file check, before any writes.
- Use `writeFileAtomic` for every `.xlsx` write that previously called `writeFile` or `toFileAsync` directly.
- Store snapshots in `.gl-data/backup/` (project-local).

Ask first:
- Increasing `keepCount` beyond 5.
- Adding restore UI.
- Snapshotting JSON sidecars in `.gl-data/`.
- Cross-filesystem rename — atomic-write fallback for that case.

Never:
- Run snapshot + write outside the existing `withLock` mutex (would race the lock).
- Snapshot the file mid-mutation. The xlsx-populate write and the JSZip patch share a single snapshot taken before either happens.
- Leave `.tmp` files behind. Cleanup on failure is mandatory.

## Non-Goals

- Restore UI.
- Off-machine backups.
- Compression of snapshot files (.xlsx is already a zip).
- Backup verification (checksum) on read.
- Snapshotting on read.

## Success Criteria

- [ ] `services/atomicWrite.js` exists and is unit-tested.
- [ ] Every `await writeFile(filePath, ...)` and `await wb.toFileAsync(filePath)` in `services/banking.js`, `services/cashflow.js`, and `services/budget.js` is replaced with the atomic helper.
- [ ] Every write function takes a snapshot once before mutating.
- [ ] Integration test passes: 6 successive writes → 5 backups, rotation deletes oldest, original always intact.
- [ ] All prior tests still pass; `npm run typecheck` still green.
