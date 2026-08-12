// Shared type definitions for server-side modules.
//
// Files opt into checking with `// @ts-check` at the top, then reference these
// types via JSDoc: `@typedef {import('../types.js').Transaction} Transaction`.
// The import path uses `.js` extension because that's what the runtime resolution
// expects; TypeScript reads `types.d.ts` automatically.

/** Italian-month abbreviation used as the sheet name in banking workbooks. */
export type Month =
  | 'GEN' | 'FEB' | 'MAR' | 'APR' | 'MAG' | 'GIU'
  | 'LUG' | 'AGO' | 'SET' | 'OTT' | 'NOV' | 'DIC';

/** Cost-side cash flow category — prefix-encoded direction. */
export type CostCategory = `C-${string}`;
/** Revenue / financing-side cash flow category. */
export type RevenueCategory = `R-${string}`;
/**
 * Cash flow category. The C-/R- prefix encodes direction:
 *  - C-* requires outflow > 0
 *  - R-* requires inflow > 0
 *
 * Enforced at runtime by `assertTransactionInvariants` in
 * `services/transactionInvariants.js`.
 */
export type CashFlowCategory = CostCategory | RevenueCategory;

/** Integer cents — alias for clarity around `services/money.js`. */
export type Cents = number;

/** Banking-row payload — what `addTransaction` and `updateTransaction` accept. */
export interface TransactionInput {
  date?: string;                        // ISO yyyy-mm-dd (route) or dd/mm/yyyy (Excel cell)
  type?: 'B' | 'C' | '';
  transaction?: string;
  notes?: string;
  iban?: string;
  inflow?: number | string | null;
  outflow?: number | string | null;
  cashFlow?: CashFlowCategory | '' | null;
  comments?: string;
}

/** Banking-row row as read back from Excel. */
export interface Transaction extends TransactionInput {
  row: number;
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

/** Attachment stored under attachmentRoot — referenced by relative path. */
export interface UnderRootAttachmentRecord extends BaseAttachmentRecord {
  storageMode: 'linked' | 'uploaded';
  relativePath: string;
}

/** Attachment stored outside attachmentRoot — referenced by absolute path. */
export interface ExternalAttachmentRecord extends BaseAttachmentRecord {
  storageMode: 'external';
  absolutePath: string;
}

/**
 * Discriminated union: code that handles `AttachmentRecord` must check
 * `storageMode` before accessing `relativePath` or `absolutePath`.
 */
export type AttachmentRecord = UnderRootAttachmentRecord | ExternalAttachmentRecord;

export type BudgetScenario = 'certo' | 'possibile' | 'ottimistico' | 'consuntivo';

export interface BudgetEntry {
  id: string;
  date: string;                         // ISO yyyy-mm-dd
  competencyMonth?: number;             // 0..11; overrides month(entry.date) for aggregation
  budgetRow: number;
  amount: number;
  scenario: BudgetScenario;
  payment?: 'inMonth' | 'lump';
  transactionKey?: string;              // e.g. 'GEN-15' — links to a banking row
  notes?: string;
}
