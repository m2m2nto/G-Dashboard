# Codebase Review — Remaining Remediation Plan

**Status:** Proposed  
**Created:** 2026-08-20  
**Scope:** Phases 3–8 from the whole-codebase review remediation plan

**Decisions confirmed 2026-09-04:** Invoices support multiple linked payments;
an Invoice becomes paid only when their total reaches its amount. Transaction and
Budget Entry persistence remains one synchronous atomic operation. Invoice
renumbering is atomic across the workbook and SQLite. Client request identity
includes the open Project as well as the selected period and view.

## Scope and current state

- **Phase 1 — Updater security:** deferred by product decision. It is intentionally not planned in this document.
- **Phase 2 — Recoverable cross-year Transaction moves:** completed in commit `1251f8a`.
- **Phases 3–8:** planned below.

The remaining work should be delivered as small, independently reviewable changes. Each bug fix requires a regression test for the exact failure scenario and a green `npm test` from `dashboard/`. Client-facing changes also require a successful production build.

## Recommended execution order

1. Phase 3 — Attachment relocation integrity
2. Phase 4 — Invoice-link consistency
3. Phase 5 — Server-owned Budget Entry synchronization
4. Phase 6 — Client request race prevention
5. Phase 7 — Reproducible Electron dependency staging
6. Phase 8 — Release artifact validation

Phases 3 and 4 protect existing data relationships and should precede client or release work. Phase 5 removes client-side ownership of a cross-store mutation before Phase 6 changes the client loading model. Phases 7 and 8 form one release-pipeline sequence and may be developed together but should remain separate commits.

---

## Phase 3 — Attachment relocation integrity

### Objective

Ensure every Attachment relocation uses SQLite as the system of record and cannot leave its file and database record pointing to different locations.

### Problem

The Transaction Attachment move route still calls the legacy JSON relocation service directly. In default SQLite mode, a physical file can move while SQLite retains the previous path. A subsequent Transaction read then reports the Attachment as missing.

### Implementation plan

1. Introduce one Attachment repository boundary with operations keyed by stable Transaction ID:
   - Read an Attachment.
   - Update its location and verification state.
   - Remove an Attachment.
   - Find other records referencing the same physical file.
2. Implement the default repository through `transaction_attachments` in SQLite.
3. Keep the JSON implementation available only for the explicit legacy store mode.
4. Resolve route parameters `(Year, Month, row)` to the stable Transaction ID at the route boundary.
5. Change the relocation operation to:
   - Validate the source and target paths before mutation.
   - Reject path traversal and unsupported extensions.
   - Refuse a destination collision unless the existing behavior explicitly disambiguates it.
   - Journal the old and new physical paths.
   - Move the file.
   - Update SQLite.
   - Restore the file to its original path if the database update fails.
6. Refresh the compatibility JSON export only after the SQLite mutation commits.
7. Make the route return the authoritative record read back from SQLite.
8. Remove direct route use of legacy Attachment mutation functions in SQLite mode.

### Regression tests

- Move an Attachment in SQLite mode, reload the Transaction, and confirm the new path persists.
- Open, verify, download, and delete the Attachment after relocation.
- Database failure after the physical rename restores the old file path.
- Process-exit recovery restores an uncommitted relocation.
- Destination collision leaves both existing files untouched.
- Shared-file references prevent unintended physical deletion.
- Legacy JSON mode retains its current behavior.

### Definition of done

- No SQLite-mode route mutates the legacy JSON Attachment store directly.
- File and SQLite location cannot diverge after a handled failure or process restart.
- Compatibility export reflects the committed SQLite record.
- Targeted tests and full `npm test` pass.

---

## Phase 4 — Invoice-link consistency

### Objective

Make invoice payment state, invoice identity, and Transaction-to-invoice links change as one coordinated operation.

### Problems

- Switching a link can mark the new invoice paid before clearing the old invoice and updating SQLite.
- Renaming or deleting an invoice does not maintain Transaction links.
- A stale link can become impossible to remove when its invoice no longer exists.
- Concurrent invoice creation or renumbering can accept the same invoice number twice.

### Product rules to adopt

- Renaming an invoice automatically updates every Transaction link to the new number.
- Deleting a linked invoice returns `409 Conflict` and reports how many links must be resolved.
- Deletion does not silently cascade or discard links.
- Unlinking a stale link is allowed even when the invoice workbook row no longer exists.
- Invoice numbers are unique within a Year under the workbook mutation lock.
- Multiple Transactions may contribute payments to the same Invoice.
- An Invoice is paid only when the sum of its linked Transaction inflows is greater than or equal to the Invoice amount.
- The payment date of a paid Invoice is the latest contributing Transaction date.
- Linking, unlinking, switching, deleting, or changing the amount or date of a contributing Transaction recalculates the affected Invoice. If its linked total falls below the Invoice amount, its payment date is cleared.

### Implementation plan

1. Create an `invoiceLinkService` that owns link, switch, and unlink operations.
2. Resolve the Transaction by stable ID and load the previous link once.
3. Determine every affected invoice workbook before making changes.
4. Preflight all workbooks:
   - Confirm requested invoice numbers exist.
   - Confirm Direction is compatible with settling a receivable.
   - Confirm files are writable and not externally modified.
5. For every affected Invoice, aggregate all linked Transaction inflows and derive its authoritative payment date from the latest contributing Transaction when the total reaches the Invoice amount; otherwise derive a cleared payment date.
6. Prepare payment-date changes to all affected workbooks before replacing any original.
7. Use the workbook recovery coordinator for the old and new invoice files.
8. Update `transaction_invoice_links` and every derived payment date within the same SQLite transaction and recovery journal as the projection commit marker.
9. Move invoice-number uniqueness validation inside the invoice workbook lock.
10. On invoice renumber, perform one atomic coordinated operation:
   - Update the invoice workbook.
   - Rekey its Attachment.
   - Update matching `transaction_invoice_links` rows.
   - Roll back SQLite and restore the workbook if any step fails.
11. On invoice deletion:
    - Query linked Transactions first.
    - Return `409` when links exist.
    - Delete only when no links remain.
12. Route Transaction amount/date changes and Transaction deletion through the same settlement recalculation so derived Invoice payment state cannot become stale.
13. Add a consistency query that reports links targeting missing invoice numbers and payment dates inconsistent with their linked totals.

### Regression tests

- Switch a Transaction from a 2025 invoice to a 2026 invoice.
- Fail while clearing the old invoice and verify neither workbook nor the link changes.
- Fail during SQLite commit and verify both invoice workbooks are restored.
- Link two partial inflows whose total is below the Invoice amount and confirm it remains unpaid.
- Add a payment that reaches the Invoice amount and confirm the latest contributing Transaction date becomes the payment date.
- Remove or reduce a contributing Transaction so the total falls below the Invoice amount and confirm the payment date is cleared.
- Change a contributing Transaction date and confirm a paid Invoice's payment date is recalculated.
- Rename a linked invoice and confirm every link follows it.
- Fail after an Invoice workbook renumber but before its Attachment or Transaction links are rekeyed and confirm the entire operation is restored.
- Reject deletion of a linked invoice with `409` and no mutations.
- Remove a stale link whose invoice no longer exists.
- Submit two concurrent creates with the same invoice number; exactly one succeeds.
- Submit two concurrent renames to the same number; exactly one succeeds.

### Definition of done

- No route sequences invoice workbook and link-store writes itself.
- A failed request cannot leave payment dates and links contradictory.
- Invoice payment state is derived consistently from all linked payments.
- Renumbering preserves links; deletion cannot create orphans.
- Targeted tests and full `npm test` pass.

---

## Phase 5 — Server-owned Budget Entry synchronization

### Objective

Move Transaction-linked Budget Entry synchronization out of client state and into the server command that mutates the Transaction.

### Problem

The client calculates the destination Year but searches for an existing Budget Entry in the selected source-year state. During a cross-year move it can call the destination-year API with a source-year entry ID, leaving the old entry orphaned after the Transaction has already moved.

### API contract

Extend Transaction add/update requests with an explicit Budget Entry instruction.
Transaction deletion removes its linked Budget Entry through the same server-owned
atomic operation, preserving the current product behavior without client coordination:

```json
{
  "budgetEntry": {
    "action": "create | update | remove | keep",
    "budgetRow": 12,
    "budgetCategory": "Consulenze",
    "competencyMonth": 2,
    "scenario": "consuntivo"
  }
}
```

The server response should include the final Transaction location, stable Transaction ID, and linked Budget Entry summary.

### Implementation plan

1. Resolve linked Budget Entries through `transaction_id`, never a client-generated `{Month}-{row}` key.
2. Add a server domain function that derives Budget Entry amount, description, date, and link from the final Transaction.
3. Handle create, update, remove, and keep in the Transaction mutation service.
4. On a cross-year move:
   - Update the linked entry's Year and date.
   - Preserve or update `competency_month` according to the request.
   - Keep the stable `transaction_id` relationship.
5. On Transaction deletion, remove its linked Budget Entry in the server command before deleting the Transaction.
6. Extend the existing synchronous recovery transaction to include every affected Banking workbook and the Budget workbook:
   - Mutate the Transaction and Budget Entry in one SQLite transaction.
   - Project every affected Banking and Budget Year before committing SQLite.
   - Record all workbook before-images in the same durable recovery journal.
   - If any projection or SQLite commit fails, roll back SQLite and restore every workbook before returning an error.
7. Return success only after the Transaction, Budget Entry, and every workbook projection have committed. Because a failed attempt leaves no mutation behind, retrying cannot create a duplicate entry.
8. Remove client logic that searches `budgetEntries`, constructs `transactionKey`, deletes a linked entry after Transaction deletion, or independently calls Budget Entry mutation APIs after saving a Transaction.
9. Reload state from the successful server response and destination period.

### Regression tests

- Create a Transaction and linked Budget Entry together.
- Update the Transaction amount and update the linked entry.
- Remove the linked entry explicitly.
- Keep the existing entry unchanged when requested.
- Move a linked Transaction from 2025 to 2026 without orphaning or duplicating the entry.
- Preserve `competencyMonth = 0` for GEN.
- Delete a Transaction and its linked Budget Entry in one server-owned operation.
- Fail the source or destination Banking or Budget projection and verify SQLite and every workbook return to their original state.
- Retry after a projection failure and confirm exactly one Transaction and one linked Budget Entry exist.

### Definition of done

- The client does not coordinate Transaction and Budget Entry persistence.
- Cross-Year moves retain one linked Budget Entry with the correct Year.
- No handled failure leaves a partial Transaction, Budget Entry, Banking workbook, or Budget workbook state.
- Targeted tests and full `npm test` pass.

---

## Phase 6 — Client request race prevention

### Objective

Prevent slow responses for an old Year, Month, or view from overwriting the currently selected state.

### Problem

The client loaders have no cancellation or request-identity guard. Rapid navigation can show old-period data beneath a new selector and can let an old request clear the loading state for a newer request.

### Implementation plan

1. Add optional `AbortSignal` support to the centralized `request()` function in `api.js`.
2. Create a reusable latest-request hook or helper per state slice:
   - Increment a request generation.
   - Abort the previous request for that slice.
   - Capture the open Project identity together with the requested Year, Month, and view.
   - Commit data only when the generation remains current.
   - Clear loading state only for the current request.
   - Abort and invalidate every active slice when the Project is opened, closed, reset, or replaced, even when the new Project uses the same Year and Month.
3. Apply the mechanism independently to:
   - Transactions.
   - Cash Flow.
   - Budget.
   - Budget Entries.
   - Invoices.
   - Charts and analytics.
   - Dashboard metrics.
   - Activity data where filters trigger reloads.
4. Treat aborts as expected control flow; do not show error toasts for them.
5. After a Transaction move, use the server-returned destination and allow one authoritative navigation load. Do not call a loader captured with the source period.
6. Separate global metadata loading from Year-dependent data so changing Year does not reload Users, all year lists, and the entire Activity Log unnecessarily.

### Regression tests

- Resolve a slow 2025 Transaction request after a fast 2026 request; 2026 remains rendered.
- Repeat for Budget, Budget Entries, Invoices, and charts.
- An aborted request does not produce an error toast.
- An older request cannot clear a newer request's loading state.
- A response from the previous Project cannot update state after another Project is opened with the same Year and Month selected.
- A moved Transaction loads its destination exactly once.
- Changing Year does not refetch Year-independent metadata.

### Definition of done

- Every period-dependent state slice rejects stale responses.
- Every Project change invalidates responses issued for the previous Project.
- Navigation cannot display data from a previous selection.
- Loading indicators reflect the latest request only.
- Targeted tests and full `npm test` pass.

---

## Phase 7 — Reproducible Electron dependency staging

### Objective

Package the exact server dependency graph represented by the committed lockfile and exercised by tests.

### Problem

The Electron build copies only `server/package.json` and runs a fresh `npm install --omit=dev`. Version ranges may therefore package dependencies different from those installed during testing.

### Implementation plan

1. Preserve a valid workspace layout in `.electron-staging`:
   - Root `package.json`.
   - Root `package-lock.json`.
   - Server `package.json` and server source.
2. Replace staging `npm install` with a lockfile-driven `npm ci` command.
3. Install only the server production dependency closure required by the packaged app.
4. Fail when:
   - The lockfile is out of date.
   - `npm ci` changes tracked files.
   - `npm ls` reports missing, invalid, or extraneous production dependencies.
5. Generate a dependency manifest containing package name, resolved version, and integrity hash for the packaged server.
6. Include the manifest in build output for later release validation.
7. Run the build from a clean checkout in CI or a clean temporary worktree.

### Regression and build tests

- A package range change without a lockfile update fails staging.
- Repeated staging from the same commit produces the same dependency manifest.
- Development-only dependencies are absent from the packaged server.
- The packaged server starts under Electron's bundled Node runtime.
- Full `npm test` runs before staging.

### Definition of done

- No release build performs an unlocked dependency installation.
- Packaged versions match the committed lockfile.
- The staged server passes `npm ls` and a packaged-start smoke test.

---

## Phase 8 — Release artifact validation

### Objective

Publish the exact Electron application produced by the current build, with embedded metadata matching the release tag.

### Problem

The release script accepts any root-level `G-Dashboard.app` directory. It does not verify the embedded version, build number, executable, architecture, or signature before publishing it under the current source version.

### Implementation plan

1. Make build and release share one explicit artifact path. Do not rediscover a separately copied root `.app`.
2. Map `package.json.buildNumber` to macOS `CFBundleVersion`.
3. Keep semver in `CFBundleShortVersionString`.
4. Add a release validation script that checks:
   - Bundle identifier.
   - Embedded version.
   - Embedded build number.
   - Expected executable existence and executable permission.
   - Supported architecture.
   - `codesign --verify --deep --strict` result under the currently selected signing policy.
   - Packaged dependency manifest presence.
5. ZIP the validated bundle, extract it into a temporary directory, and repeat the bundle checks against the extracted copy.
6. Generate and print the ZIP SHA-256 for release records.
7. Refuse to publish when:
   - The Git tag already exists.
   - A release asset with the same name already exists.
   - Source metadata and bundle metadata disagree.
   - Validation or ZIP round-trip fails.
8. Delete temporary ZIPs only after release creation succeeds; retain them on failure for diagnosis.
9. Update the release runbook so the documented path matches the automated workflow.

### Regression and script tests

- Reject a stale bundle version.
- Reject a stale build number.
- Reject a missing or non-executable main binary.
- Reject the wrong architecture.
- Reject invalid bundle identity or failed code-sign verification.
- Reject a corrupt ZIP round-trip.
- Reject an existing tag or existing asset without modifying the release.
- Accept a fixture bundle whose metadata matches the requested release.

### Definition of done

- Release input comes directly from the current build.
- Source, bundle, tag, and asset metadata agree.
- Invalid or stale bundles cannot be published.
- The release runbook and scripts describe the same workflow.

---

## Cross-phase delivery checklist

For each phase:

1. Create or update the implementation task and list dependencies.
2. Reproduce the exact reviewed failure with a regression test where applicable.
3. Implement the smallest domain-level fix without unrelated refactoring.
4. Run targeted tests while iterating.
5. Complete read-only review and resolve findings.
6. Run from `dashboard/`:

   ```bash
   npm test
   ```

7. Run the client production build when client build behavior changes. Increment `buildNumber` only when creating an actual build.
8. Update the relevant specification, ADR, or release runbook when behavior or architectural ownership changes.
9. Commit each phase separately with a message describing the prevented failure.

## Overall completion criteria

The remaining remediation program is complete when:

- Attachment paths are authoritative in SQLite and recoverable with their files.
- Invoice payment state and Transaction links cannot diverge.
- Transaction-linked Budget Entries are owned by the server mutation workflow.
- Stale client requests cannot overwrite the current selection.
- Electron dependencies are staged from the committed lockfile.
- Release scripts reject stale, mismatched, or invalid application bundles.
- All targeted regressions and the full test suite pass.
