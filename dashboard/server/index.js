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
import { hasProject } from './config.js';
import { useStore } from './services/txStore.js';
import { runStartupChecks } from './services/consistencyCheck.js';
import { recoverPendingWorkbookMutations } from './services/writeTransaction.js';
import { acquireProjectAccess } from './services/projectActivation.js';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;

app.use(cors({ origin: localCorsOptions }));
app.use(express.json());
app.use('/api', async (req, res, next) => {
  try {
    const projectChangingRequest = req.method === 'POST' && [
      '/settings/open-project',
      '/settings/create-project',
      '/settings/reset',
    ].includes(req.path);
    const release = await acquireProjectAccess({ exclusive: projectChangingRequest });
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      release();
    };
    res.once('finish', releaseOnce);
    res.once('close', releaseOnce);
    next();
  } catch (err) {
    res.status(503).json({ error: err.message || 'Project activation failed' });
  }
});

// The one-time JSON→SQLite import of the four non-row-keyed stores (CF Mapping,
// folder memory, invoice attachments, audit) used to run here, holding every
// `/api/*` request until it finished. Both existing data directories were
// verified migrated on 2026-08-13, so it moved to Settings → Legacy Import —
// temporary, and slated for removal with the module itself. See
// `services/import/importRemainingStores.js`.
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

// Recovery must finish before the server binds or signals readiness. SQLite
// automatically rolls back an interrupted transaction on open; the durable
// projection journal now brings every Banking file to the same outcome before
// any route can observe or mutate the Project.
if (useStore() && hasProject()) {
  const recovery = await recoverPendingWorkbookMutations();
  if (recovery.restored || recovery.completed || recovery.discarded) {
    console.log(
      `Workbook recovery: ${recovery.restored} restored, ` +
      `${recovery.completed} committed, ${recovery.discarded} incomplete journal(s) discarded.`,
    );
  }
}

app.listen(PORT, HOST, async () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  if (process.send) process.send({ type: 'ready', port: PORT });
  if (APP_DIR) console.log(`Serving client from ${resolve(APP_DIR, 'public')}`);
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
