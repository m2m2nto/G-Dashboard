import express from 'express';
import cors from 'cors';
import { resolve } from 'path';
import transactionsRouter from './routes/transactions.js';
import cashflowRouter from './routes/cashflow.js';
import metadataRouter from './routes/metadata.js';
import chartsRouter from './routes/charts.js';
import activityRouter from './routes/activity.js';
import settingsRouter from './routes/settings.js';
import budgetRouter from './routes/budget.js';
import { ensureBankingFile } from './services/excel.js';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;

app.use(cors());
app.use(express.json());

app.use('/api/transactions', transactionsRouter);
app.use('/api/cashflow', cashflowRouter);
app.use('/api/metadata', metadataRouter);
app.use('/api/charts', chartsRouter);
app.use('/api/activity', activityRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/budget', budgetRouter);

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

app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
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
});
