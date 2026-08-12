# Spec: Incremental JSDoc Types for `server/services/`

> **Status:** Draft. Adds opt-in type checking via JSDoc + `// @ts-check` for the highest-leverage server modules. No `.ts` files, no runtime change, no build-tool change.

## Objective

Catch a class of latent bugs at edit time instead of at incident time by giving the most bug-prone server modules real type contracts — without restructuring the toolchain.

The motivating example is the recipient-category-decoupling incident: a refund row ended up with a `C-` category, breaking the direction/category invariant silently. A categorical-string type `` `C-${string}` | `R-${string}` `` on the `Transaction.cashFlow` field would have caught the broken assignment statically.

## Why JSDoc instead of `.ts` files

The original recommendation called this out explicitly: JSDoc + `// @ts-check` delivers the same compile-time guarantees for the files that opt in, with **zero runtime change** and **zero build-step change**. The trade-off:

| Aspect | JSDoc + ts-check | Full `.ts` migration |
|---|---|---|
| Build step | None — Vite/Electron unaffected | New `tsc` (or `tsx`) step |
| File renames | None | All server files `.js → .ts` |
| IDE feedback | Yes (TS LSP picks up `@ts-check`) | Yes |
| Type expressiveness | ~95% of TS (no enums, no decorators) | 100% |
| Opt-in granularity | File-by-file via `// @ts-check` | All-or-nothing per workspace |
| Rollback | Delete `// @ts-check` from one file | Revert filenames + build |

We pick the cheaper option. If real friction shows up later (e.g., template-literal types limit something we need), we can migrate the few files that need it.

## Scope

In:
- `server/services/money.js`
- `server/services/transactionInvariants.js`
- `server/services/transactionAttachments.js`
- `server/services/budgetEntries.js`
- `server/services/banking.js` and `server/services/cashflow.js` (formerly `services/excel.js`; the 25+ exported boundary functions — internals stay unannotated)

Out (deferred):
- `server/routes/transactions.js` and other route files — large surface, low marginal value once the services are typed.
- All other `server/services/*.js` files (settings.js, project.js, audit.js, cfBudgetCategoryMap.js, budgetCategoryMap.js, transactionTimestamps.js, httpSecurity.js, osascript.js).
- The whole client.

## Tech Stack

- `typescript` as **devDependency** of the `server` workspace.
- One `server/tsconfig.json` with `allowJs: true, checkJs: false, noEmit: true, strict: true`. `checkJs: false` means files only get checked when they carry `// @ts-check`.
- `npm run typecheck --workspace=server` runs `tsc --noEmit`.

No runtime dependency on TypeScript. The Electron build, the Vite client build, and `npm test` are all unaffected.

## Type Definitions

New `server/types.d.ts` exports the shared types:

```ts
export type Month = 'GEN' | 'FEB' | 'MAR' | 'APR' | 'MAG' | 'GIU'
                  | 'LUG' | 'AGO' | 'SET' | 'OTT' | 'NOV' | 'DIC';

/** Cash flow category — prefix-encoded direction. */
export type CostCategory = `C-${string}`;
export type RevenueCategory = `R-${string}`;
export type CashFlowCategory = CostCategory | RevenueCategory;

/** Integer cents — alias for clarity around money.js. */
export type Cents = number;

export interface Transaction {
  row: number;
  date: string;                         // dd/mm/yyyy
  type?: 'B' | 'C' | '';
  transaction: string;
  notes?: string;
  iban?: string;
  inflow?: number;
  outflow?: number;
  cashFlow?: CashFlowCategory | '';
  comments?: string;
}

export type StorageMode = 'linked' | 'uploaded' | 'external';

interface BaseAttachmentRecord {
  fileName: string;
  originalFileName: string;
  mimeType: string;
  size: number;
  linkedAt: string;
  updatedAt: string;
  status: 'unknown' | 'present' | 'missing';
  lastVerifiedAt: string | null;
}

export interface UnderRootAttachmentRecord extends BaseAttachmentRecord {
  storageMode: 'linked' | 'uploaded';
  relativePath: string;
}

export interface ExternalAttachmentRecord extends BaseAttachmentRecord {
  storageMode: 'external';
  absolutePath: string;
}

export type AttachmentRecord = UnderRootAttachmentRecord | ExternalAttachmentRecord;

export type BudgetScenario = 'certo' | 'possibile' | 'ottimistico' | 'consuntivo';

export interface BudgetEntry {
  id: string;
  date: string;
  competencyMonth?: number;             // 0..11
  budgetRow: number;
  amount: number;
  scenario: BudgetScenario;
  payment?: 'inMonth' | 'lump';
  transactionKey?: string;
  notes?: string;
}
```

The `AttachmentRecord` discriminated union is the most valuable definition — it makes a "use `relativePath` for under-root, `absolutePath` for external" mistake a compile error.

## Annotation Pattern

Per file:

```js
// @ts-check
/** @typedef {import('../types.js').Transaction} Transaction */
/** @typedef {import('../types.js').CashFlowCategory} CashFlowCategory */

/**
 * @param {Pick<Transaction, 'inflow' | 'outflow' | 'cashFlow'>} row
 * @returns {void}
 */
export function assertTransactionInvariants(row) { ... }
```

Internal helpers can stay un-annotated; type inference flows through them. We annotate only the **boundary** — function signatures of public exports.

## Success Criteria

- [ ] `npm run typecheck --workspace=server` exits 0.
- [ ] All five target files carry `// @ts-check`.
- [ ] `npm test` still passes end-to-end with no regressions.
- [ ] Vite client build still succeeds (unaffected, but verify).
- [ ] Electron build still succeeds (unaffected, but verify).

## Boundaries

Always:
- Keep types in `server/types.d.ts` so they're reusable from any service.
- Use template-literal types for prefixed strings (`CashFlowCategory`) — that's the whole point.
- Annotate the **public** function signature; let inference handle the body.

Ask first:
- Adding `@ts-check` to `routes/*.js` (express types are noisy; would need `@types/express`).
- Migrating any file to `.ts`.
- Enabling `checkJs: true` globally — that would force every file to pass type checking before merge.

Never:
- Change behavior to satisfy a type — fix the type instead.
- Add `// @ts-ignore` to silence a real error. Either fix the type or refactor the call site.
- Ship if `npm run typecheck` fails.

## Non-Goals

- Client-side typing.
- 100% type coverage in the typed files (internals can stay loose).
- Replacing tests with types — types catch shape errors, tests catch behavior errors. We keep both.
