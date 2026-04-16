import { readFile, writeFile, mkdir, access, stat, rename } from 'fs/promises';
import { join, extname, resolve, relative, isAbsolute, basename, dirname } from 'path';
import { getDataDir } from '../config.js';

const ATTACHMENTS_VERSION = 1;
const ALLOWED_ATTACHMENT_EXTENSIONS = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
]);

const MIME_TYPES_BY_EXTENSION = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function getDir() {
  return join(getDataDir(), '.gl-data');
}

function getFile(year) {
  return join(getDir(), `transaction-attachments-${year}.json`);
}

function createEmptyEnvelope() {
  return {
    version: ATTACHMENTS_VERSION,
    attachments: {},
  };
}

function normalizeEnvelope(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return createEmptyEnvelope();
  }

  const attachments = data.attachments && typeof data.attachments === 'object' && !Array.isArray(data.attachments)
    ? data.attachments
    : {};

  return {
    version: typeof data.version === 'number' ? data.version : ATTACHMENTS_VERSION,
    attachments,
  };
}

async function readAll(year) {
  try {
    const raw = await readFile(getFile(year), 'utf8');
    return normalizeEnvelope(JSON.parse(raw));
  } catch (err) {
    if (err.code === 'ENOENT') return createEmptyEnvelope();
    throw err;
  }
}

async function writeAll(year, data) {
  const dir = getDir();
  await mkdir(dir, { recursive: true });
  await writeFile(getFile(year), JSON.stringify(normalizeEnvelope(data), null, 2), 'utf8');
}

const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

export function buildAttachmentDispositionHeader(fileName, { download } = {}) {
  const type = download ? 'attachment' : 'inline';
  const safeName = String(fileName || 'attachment').replace(/"/g, '');
  return `${type}; filename="${safeName}"`;
}

export function buildAttachmentKey(month, row) {
  return `${month}-${row}`;
}

export function sanitizeAttachmentPathSegment(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildDefaultAttachmentRelativePath({ date, recipient, originalFileName }) {
  const safeRecipient = sanitizeAttachmentPathSegment(recipient);
  const ext = extname(originalFileName || '');
  const dateDigits = String(date || '').replace(/-/g, '');
  const year = dateDigits.slice(0, 4);
  const baseName = sanitizeAttachmentPathSegment(`${dateDigits} - ${recipient}`);

  return join(year, safeRecipient, `${baseName}${ext}`);
}

export function isAllowedAttachmentFileName(fileName) {
  const ext = extname(String(fileName || '')).toLowerCase();
  return ALLOWED_ATTACHMENT_EXTENSIONS.has(ext);
}

export function inferAttachmentMimeType(fileName) {
  const ext = extname(String(fileName || '')).toLowerCase();
  return MIME_TYPES_BY_EXTENSION[ext] || 'application/octet-stream';
}

export function toAttachmentRelativePath(rootDir, absolutePath) {
  if (!rootDir) throw new Error('Attachment root is required');
  if (!absolutePath) throw new Error('Attachment path is required');
  if (!isAbsolute(absolutePath)) throw new Error('Path must be absolute');

  const resolvedRoot = resolve(rootDir);
  const resolvedPath = resolve(absolutePath);
  const rel = relative(resolvedRoot, resolvedPath);

  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Path must stay under attachment root');
  }

  return rel;
}

export function decideAttachmentMode(rootDir, { relativePath, absolutePath } = {}) {
  if (!rootDir) throw new Error('Attachment root is required');
  if (!relativePath && !absolutePath) {
    throw new Error('relativePath or absolutePath is required');
  }
  if (relativePath) {
    return { mode: 'link', relativePath };
  }
  if (!isAbsolute(absolutePath)) {
    throw new Error('absolutePath must be absolute');
  }
  try {
    const rel = toAttachmentRelativePath(rootDir, absolutePath);
    return { mode: 'link', relativePath: rel };
  } catch {
    return { mode: 'upload', absolutePath };
  }
}

export function resolveAttachmentPathUnderRoot(rootDir, relativePath) {
  if (!rootDir) throw new Error('Attachment root is required');
  if (!relativePath) throw new Error('Attachment path is required');
  if (isAbsolute(relativePath)) throw new Error('Attachment path must be relative');

  const resolvedRoot = resolve(rootDir);
  const resolvedPath = resolve(resolvedRoot, relativePath);
  const rel = relative(resolvedRoot, resolvedPath);

  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Attachment path must stay under attachment root');
  }

  return resolvedPath;
}

export async function createUploadedAttachmentRecord(rootDir, { buffer, originalFileName, date, recipient, relativePath }) {
  if (!originalFileName) {
    throw new Error('Original file name is required');
  }
  if (!isAllowedAttachmentFileName(originalFileName)) {
    throw new Error('Attachment file type is not allowed');
  }

  const targetRelativePath = relativePath || buildDefaultAttachmentRelativePath({
    date,
    recipient,
    originalFileName,
  });
  const resolvedPath = resolveAttachmentPathUnderRoot(rootDir, targetRelativePath);

  try {
    await access(resolvedPath);
    throw new Error('Attachment destination already exists');
  } catch (err) {
    if (err.message === 'Attachment destination already exists') throw err;
    if (err.code !== 'ENOENT') throw err;
  }

  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, buffer);

  const fileInfo = await stat(resolvedPath);
  const now = new Date().toISOString();
  const fileName = basename(targetRelativePath);
  return {
    relativePath: targetRelativePath,
    fileName,
    originalFileName,
    mimeType: inferAttachmentMimeType(originalFileName),
    size: fileInfo.size,
    linkedAt: now,
    updatedAt: now,
    status: 'unknown',
    lastVerifiedAt: null,
    storageMode: 'uploaded',
  };
}

export async function createLinkedAttachmentRecord(rootDir, relativePath) {
  const resolvedPath = resolveAttachmentPathUnderRoot(rootDir, relativePath);
  const fileName = basename(relativePath);
  if (!isAllowedAttachmentFileName(fileName)) {
    throw new Error('Attachment file type is not allowed');
  }

  const fileInfo = await stat(resolvedPath);
  if (!fileInfo.isFile()) {
    throw new Error('Attachment path must point to a file');
  }

  const now = new Date().toISOString();
  return {
    relativePath,
    fileName,
    originalFileName: fileName,
    mimeType: inferAttachmentMimeType(fileName),
    size: fileInfo.size,
    linkedAt: now,
    updatedAt: now,
    status: 'unknown',
    lastVerifiedAt: null,
    storageMode: 'linked',
  };
}

export async function moveAttachmentFile(rootDir, oldRelativePath, newRelativePath) {
  if (!oldRelativePath || !newRelativePath) {
    throw new Error('Old and new attachment paths are required');
  }
  if (!isAllowedAttachmentFileName(newRelativePath)) {
    throw new Error('Attachment file type is not allowed');
  }
  const oldResolved = resolveAttachmentPathUnderRoot(rootDir, oldRelativePath);
  const newResolved = resolveAttachmentPathUnderRoot(rootDir, newRelativePath);
  if (oldResolved === newResolved) return { moved: false };

  try {
    await access(newResolved);
    throw new Error('Attachment destination already exists');
  } catch (err) {
    if (err.message === 'Attachment destination already exists') throw err;
    if (err.code !== 'ENOENT') throw err;
  }

  await mkdir(dirname(newResolved), { recursive: true });
  await rename(oldResolved, newResolved);
  return { moved: true };
}

export async function relocateAttachment(rootDir, year, month, row, newRelativePath) {
  const existing = await getAttachment(year, month, row);
  if (!existing) {
    const err = new Error('Attachment not found');
    err.code = 'ATTACHMENT_NOT_FOUND';
    throw err;
  }
  if (existing.relativePath === newRelativePath) {
    return existing;
  }

  await moveAttachmentFile(rootDir, existing.relativePath, newRelativePath);

  const now = new Date().toISOString();
  const updated = {
    ...existing,
    relativePath: newRelativePath,
    fileName: basename(newRelativePath),
    updatedAt: now,
    status: 'present',
    lastVerifiedAt: now,
  };
  await setAttachment(year, month, row, updated);
  return updated;
}

export async function verifyAttachmentRecord(rootDir, attachment) {
  const now = new Date().toISOString();

  if (!attachment?.relativePath || !rootDir) {
    return {
      ...attachment,
      status: 'unknown',
      lastVerifiedAt: now,
    };
  }

  const resolvedPath = resolveAttachmentPathUnderRoot(rootDir, attachment.relativePath);

  try {
    await access(resolvedPath);
    return {
      ...attachment,
      status: 'present',
      lastVerifiedAt: now,
    };
  } catch {
    return {
      ...attachment,
      status: 'missing',
      lastVerifiedAt: now,
    };
  }
}

export async function verifyAttachmentsMap(rootDir, attachments) {
  const verified = {};
  let updated = 0;

  for (const [key, attachment] of Object.entries(attachments || {})) {
    const next = await verifyAttachmentRecord(rootDir, attachment);
    verified[key] = next;
    if (JSON.stringify(next) !== JSON.stringify(attachment)) {
      updated++;
    }
  }

  return { attachments: verified, updated };
}

export async function getAttachments(year) {
  return readAll(year);
}

export async function getAttachment(year, month, row) {
  const data = await readAll(year);
  return data.attachments[buildAttachmentKey(month, row)] || null;
}

export async function findAttachmentReferences(years, relativePath, { exclude } = {}) {
  const matches = [];

  for (const year of years) {
    const data = await readAll(year);
    for (const [key, attachment] of Object.entries(data.attachments)) {
      if (attachment?.relativePath !== relativePath) continue;
      if (exclude && exclude.year === year && exclude.key === key) continue;
      matches.push({ year, key, attachment });
    }
  }

  return matches;
}

export async function setAttachment(year, month, row, attachment) {
  return withLock(`attachments-${year}`, async () => {
    const data = await readAll(year);
    data.attachments[buildAttachmentKey(month, row)] = attachment;
    await writeAll(year, data);
    return attachment;
  });
}

export async function removeAttachment(year, month, row) {
  return withLock(`attachments-${year}`, async () => {
    const data = await readAll(year);
    const key = buildAttachmentKey(month, row);
    const existing = data.attachments[key] || null;
    if (existing) {
      delete data.attachments[key];
      await writeAll(year, data);
    }
    return existing;
  });
}

export async function shiftAttachmentsOnDelete(year, month, deletedRow) {
  return withLock(`attachments-${year}`, async () => {
    const data = await readAll(year);
    const prefix = `${month}-`;
    const toDelete = [];
    const toShift = [];

    for (const key of Object.keys(data.attachments)) {
      if (!key.startsWith(prefix)) continue;
      const row = parseInt(key.slice(prefix.length), 10);
      if (row === deletedRow) {
        toDelete.push(key);
      } else if (row > deletedRow) {
        toShift.push({
          oldKey: key,
          newKey: `${prefix}${row - 1}`,
          value: data.attachments[key],
        });
        toDelete.push(key);
      }
    }

    for (const key of toDelete) delete data.attachments[key];
    for (const { newKey, value } of toShift) data.attachments[newKey] = value;

    await writeAll(year, data);
  });
}
