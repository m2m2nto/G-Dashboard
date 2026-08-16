// @ts-check
import { readFile } from 'fs/promises';
import { join, isAbsolute } from 'path';
import { getDataDir } from '../config.js';
import { writeFileAtomic } from './atomicWrite.js';

function getMemoryDir() {
  return join(getDataDir(), '.gl-data');
}

function getMemoryFile() {
  return join(getMemoryDir(), 'attachment-folder-memory.json');
}

function normalizeRecipient(recipient) {
  return String(recipient || '').trim().toLowerCase();
}

function normalizeType(type) {
  return String(type || '').trim().toLowerCase();
}

// Memory is scoped by (type, recipient). When no type is given we fall back to a
// recipient-only key so older recipient-keyed records keep round-tripping.
function buildKey(recipient, type) {
  const recipientKey = normalizeRecipient(recipient);
  if (!recipientKey) return '';
  const typeKey = normalizeType(type);
  return typeKey ? `${typeKey}::${recipientKey}` : recipientKey;
}

function normalizeFolder(folder) {
  if (!folder || typeof folder !== 'object' || Array.isArray(folder)) return null;
  const absolutePath = typeof folder.absolutePath === 'string' ? folder.absolutePath.trim() : '';
  if (!absolutePath || !isAbsolute(absolutePath)) return null;
  const relativeFolder = typeof folder.relativeFolder === 'string' && folder.relativeFolder.trim() !== ''
    ? folder.relativeFolder.trim()
    : null;
  return { absolutePath, relativeFolder };
}

function normalizeDir(dir) {
  const value = typeof dir === 'string' ? dir.trim() : '';
  return value && isAbsolute(value) ? value : null;
}

async function readAll() {
  try {
    const raw = await readFile(getMemoryFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { recipients: {} };
    return {
      version: parsed.version || 1,
      recipients: parsed.recipients && typeof parsed.recipients === 'object' && !Array.isArray(parsed.recipients)
        ? parsed.recipients
        : {},
    };
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, recipients: {} };
    throw err;
  }
}

async function writeAll(data) {
  await writeFileAtomic(getMemoryFile(), JSON.stringify({ version: 1, recipients: data.recipients || {} }, null, 2));
}

const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

export async function getRememberedDestinationFolder(recipient, type) {
  const key = buildKey(recipient, type);
  if (!key) return null;
  const data = await readAll();
  const record = data.recipients[key];
  const folder = normalizeFolder(record);
  return folder ? { ...folder, updatedAt: record.updatedAt || null } : null;
}

export async function setRememberedDestinationFolder(recipient, folder, type) {
  const key = buildKey(recipient, type);
  if (!key) throw new Error('recipient is required');
  const normalized = normalizeFolder(folder);
  if (!normalized) throw new Error('absolutePath must be an absolute path');
  return withLock('attachment-folder-memory', async () => {
    const data = await readAll();
    data.recipients[key] = {
      ...data.recipients[key],
      ...normalized,
      updatedAt: new Date().toISOString(),
    };
    await writeAll(data);
    return data.recipients[key];
  });
}

export async function clearRememberedDestinationFolder(recipient, type) {
  const key = buildKey(recipient, type);
  if (!key) return { ok: true };
  return withLock('attachment-folder-memory', async () => {
    const data = await readAll();
    const record = data.recipients[key];
    if (record) {
      // Drop only the folder fields; keep any remembered file directory.
      const { absolutePath, relativeFolder, updatedAt, ...rest } = record;
      if (Object.keys(rest).length > 0) data.recipients[key] = rest;
      else delete data.recipients[key];
      await writeAll(data);
    }
    return { ok: true };
  });
}

export async function getRememberedFileDirectory(recipient, type) {
  const key = buildKey(recipient, type);
  if (!key) return null;
  const data = await readAll();
  const record = data.recipients[key];
  const fileDir = normalizeDir(record?.fileDir);
  return fileDir ? { absolutePath: fileDir, updatedAt: record.fileDirUpdatedAt || null } : null;
}

export async function setRememberedFileDirectory(recipient, absolutePath, type) {
  const key = buildKey(recipient, type);
  if (!key) throw new Error('recipient is required');
  const fileDir = normalizeDir(absolutePath);
  if (!fileDir) throw new Error('absolutePath must be an absolute path');
  return withLock('attachment-folder-memory', async () => {
    const data = await readAll();
    data.recipients[key] = {
      ...data.recipients[key],
      fileDir,
      fileDirUpdatedAt: new Date().toISOString(),
    };
    await writeAll(data);
    return { absolutePath: fileDir, updatedAt: data.recipients[key].fileDirUpdatedAt };
  });
}

export const __test = { normalizeFolder, normalizeRecipient, normalizeDir, buildKey };
