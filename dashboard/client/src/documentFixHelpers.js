/**
 * Relink a document row whose attachment status is "unknown" to a newly
 * picked file, mirroring the Transactions attach flow.
 *
 * Sends the attach request with `replace: true` so the server overwrites the
 * broken record atomically (no remove-then-attach window), then re-runs
 * attachment verification so the stored status reflects the new file.
 *
 * Pure orchestration; `attach` and `verify` are injected so tests can assert
 * call order and payloads without network access.
 *
 * @param {{ year: number|string, month: string, row: number }} item
 * @param {{ relativePath?: string, absolutePath?: string, destinationFolder?: object|null }} payload
 * @param {{ attach: Function, verify: Function }} deps
 * @returns {Promise<any>} the attach result (has `mode` for toast wording)
 */
export async function relinkDocumentAttachment(item, payload, { attach, verify }) {
  const result = await attach(item.year, item.month, item.row, { ...payload, replace: true });
  try {
    await verify();
  } catch {
    // Verification is best-effort; the relink itself already succeeded.
  }
  return result;
}
