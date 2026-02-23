import { readFile, readdir, appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getDataDir } from '../config.js';

// Audit data lives alongside the Excel files so it follows the data directory
function getAuditDir() {
  return join(getDataDir(), '.gulliver-data', 'audit');
}

function dayPath(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return { dir: join(getAuditDir(), String(y), m), file: `${d}.jsonl` };
}

export async function appendEntry(entry) {
  const now = new Date();
  const { dir, file } = dayPath(now);
  await mkdir(dir, { recursive: true });
  const line = JSON.stringify({ ts: now.toISOString(), ...entry }) + '\n';
  await appendFile(join(dir, file), line, 'utf8');
}

async function parseFile(filePath) {
  let content;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

export async function readEntries() {
  let years;
  try {
    years = await readdir(getAuditDir());
  } catch {
    return [];
  }

  // Collect all day files with sortable path (YYYY/MM/DD)
  const auditDir = getAuditDir();
  const files = [];
  for (const y of years.sort().reverse()) {
    let months;
    try { months = await readdir(join(auditDir, y)); } catch { continue; }
    for (const m of months.sort().reverse()) {
      let days;
      try { days = await readdir(join(auditDir, y, m)); } catch { continue; }
      for (const d of days.sort().reverse()) {
        if (d.endsWith('.jsonl')) files.push(join(auditDir, y, m, d));
      }
    }
  }

  // Read all files newest-day-first, entries within each day reversed
  const all = [];
  for (const f of files) {
    const entries = await parseFile(f);
    all.push(...entries.reverse());
  }
  return all;
}
