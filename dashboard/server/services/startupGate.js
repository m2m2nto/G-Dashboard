// @ts-check

/**
 * Hold `/api/*` requests until the one-time JSON→SQLite imports have finished.
 *
 * The imports cannot simply run before `listen()`: Electron gives the server
 * 15 seconds to signal `ready` (`electron/main.cjs`), and reading the audit
 * archive off cloud-synced storage can take longer than that. But serving
 * requests while an import is still running is what produced the false "data
 * does not match the Lux Cash Flow" banner — a half-imported `cf_budget_map`
 * makes every mapped Transaction resolve to no Budget row, so the by-budget
 * numbers come back wrong with no error anywhere.
 *
 * The gate keeps both properties: the port opens immediately, and no request is
 * answered against a half-imported database.
 *
 * A failed import is **not** waved through. The empty-table gate in
 * `importRemainingStores` means a failure leaves the table empty for good, so
 * letting requests past would serve wrong numbers indefinitely; 503 with the
 * reason is the only honest answer.
 *
 * @param {() => Promise<unknown>} run started immediately, once
 * @returns {(req: any, res: any, next: () => void) => Promise<void>}
 */
export function createStartupGate(run) {
  // Settled to `null` on success, to the Error on failure — never rejected, so
  // a failure before the first request cannot surface as an unhandled rejection.
  const settled = run().then(
    () => null,
    (err) => (err instanceof Error ? err : new Error(String(err))),
  );

  return async function startupGate(req, res, next) {
    const err = await settled;
    if (!err) return next();
    res.status(503).json({ error: `Startup import failed: ${err.message}` });
  };
}
