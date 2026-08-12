// @ts-check
import express from 'express';
import cors from 'cors';
import { resolve } from 'path';
import { getListenHost, localCorsOptions } from './services/httpSecurity.js';
import transactionsRouter from './routes/transactions.js';
import cashflowRouter from './routes/cashflow.js';
import metadataRouter from './routes/metadata.js';
import chartsRouter from './routes/charts.js';
import activityRouter from './routes/activity.js';
import settingsRouter from './routes/settings.js';
import budgetRouter from './routes/budget.js';
import budgetEntriesRouter from './routes/budgetEntries.js';
import attachmentsRouter from './routes/attachments.js';
import reconciliationRouter from './routes/reconciliation.js';
import invoicesRouter from './routes/invoices.js';
import { ensureBankingFile } from './services/banking.js';
import { useStore } from './services/txStore.js';
import { runStartupChecks } from './services/consistencyCheck.js';
import { importRemainingStores } from './services/import/importRemainingStores.js';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;

app.use(cors({ origin: localCorsOptions }));
app.use(express.json());

app.use('/api/transactions', transactionsRouter);
app.use('/api/cashflow', cashflowRouter);
app.use('/api/metadata', metadataRouter);
app.use('/api/charts', chartsRouter);
app.use('/api/activity', activityRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/budget', budgetRouter);
app.use('/api/budget-entries', budgetEntriesRouter);
app.use('/api/attachments', attachmentsRouter);
app.use('/api/reconciliation', reconciliationRouter);
app.use('/api/invoices', invoicesRouter);

// In .app bundle mode, serve the built client as static files
const APP_DIR = process.env.GULLIVER_APP_DIR;
if (APP_DIR) {
  const publicDir = resolve(APP_DIR, 'public');
  app.use(express.static(publicDir));
  // SPA fallback: non-API GET requests serve index.html
  app.get('*', (req, res) => {
    res.sendFile(resolve(publicDir, 'index.html'));
  });
}

const HOST = getListenHost();

app.listen(PORT, HOST, async () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  if (process.send) process.send({ type: 'ready', port: PORT });
  if (APP_DIR) console.log(`Serving client from ${resolve(APP_DIR, 'public')}`);
  // The four non-row-keyed stores (CF Mapping, folder memory, invoice
  // attachments, audit) are DB-backed under either GL_STORE flag, so their
  // one-time import from the JSON archives always runs — and first, before
  // anything can append an audit entry past the empty-table gate.
  try {
    const imported = await importRemainingStores();
    for (const [store, result] of Object.entries(imported)) {
      if (result.imported > 0) console.log(`Store import: ${store} ${result.imported} record(s) from the JSON archive.`);
    }
  } catch (err) {
    console.error('Remaining-store import failed:', err.message);
  }
  // Ensure the current year's banking file exists (auto-create from template if needed)
  const currentYear = String(new Date().getFullYear());
  try {
    const created = await ensureBankingFile(currentYear);
    if (created) console.log(`Created banking file for ${currentYear}`);
  } catch (err) {
    console.error(`Failed to create banking file for ${currentYear}:`, err.message);
  }
  // The Transaction store import and consistency check stay behind the flag:
  // under `GL_STORE=json` the workbooks are still the system of record there.
  if (useStore()) {
    try {
      await runStartupChecks();
    } catch (err) {
      console.error('Store startup checks failed:', err.message);
    }
  }
});
