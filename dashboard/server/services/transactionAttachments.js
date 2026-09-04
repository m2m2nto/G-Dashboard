// @ts-check
import { readFile, writeFile, mkdir, access, stat, rename } from 'fs/promises';
import { join, extname, resolve, relative, isAbsolute, basename, dirname } from 'path';
import { getDataDir } from '../config.js';

/** @typedef {import('../types.js').AttachmentRecord} AttachmentRecord */
/** @typedef {import('../types.js').StorageMode} StorageMode */

const ATTACHMENTS_VERSION = 1;
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
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

export function attachmentError(code, message) {
  const err = /** @type {Error & { code: string }} */ (new Error(message));
  err.code = code;
  return err;
}

export function statusForAttachmentError(err) {
  switch (err?.code) {
    case 'ATTACHMENT_COLLISION':
      return 409;
    case 'ATTACHMENT_TYPE_REJECTED':
    case 'ATTACHMENT_PATH_INVALID':
    case 'ATTACHMENT_PATH_ESCAPE':
    case 'ATTACHMENT_PATH_NOT_ABSOLUTE':
    case 'ATTACHMENT_NOT_FILE':
    case 'ATTACHMENT_SEGMENT_INVALID':
    case 'ATTACHMENT_TOO_LARGE':
      return 422;
    case 'ATTACHMENT_NOT_FOUND':
      return 404;
    case 'ENOENT':
      return 404;
    default:
      return null;
  }
}

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
  const target = getFile(year);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(normalizeEnvelope(data), null, 2), 'utf8');
  await rename(tmp, target);
}

const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

/**
 * @param {string} fileName
 * @param {{ download?: boolean }} [opts]
 */
export function buildAttachmentDispositionHeader(fileName, { download } = {}) {
  const type = download ? 'attachment' : 'inline';
  const safeName = String(fileName || 'attachment').replace(/"/g, '');
  return `${type}; filename="${safeName}"`;
}

export function buildAttachmentKey(month, row) {
  return `${month}-${row}`;
}

export function sanitizeAttachmentPathSegment(value) {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || /^\.+$/.test(cleaned)) {
    throw attachmentError('ATTACHMENT_SEGMENT_INVALID', 'Invalid attachment path segment');
  }
  return cleaned;
}

export function buildAttachmentFileName({ date, recipient, originalFileName }) {
  const ext = extname(originalFileName || '');
  const dateDigits = String(date || '').replace(/-/g, '');
  const baseName = sanitizeAttachmentPathSegment(`${dateDigits} - ${recipient}`);
  return `${baseName}${ext}`;
}

export function buildDefaultAttachmentRelativePath({ date, recipient, originalFileName }) {
  const safeRecipient = sanitizeAttachmentPathSegment(recipient);
  const dateDigits = String(date || '').replace(/-/g, '');
  const year = dateDigits.slice(0, 4);
  const fileName = buildAttachmentFileName({ date, recipient, originalFileName });

  return join(year, safeRecipient, fileName);
}

export function deriveRecipientFromRelativePath(relativePath) {
  const parts = String(relativePath || '').split(/[\\/]/).filter(Boolean);
  if (parts.length >= 3) return parts[1];
  if (parts.length >= 2) return parts[0];
  return '';
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
  if (!rootDir) throw attachmentError('ATTACHMENT_PATH_INVALID', 'Attachment root is required');
  if (!absolutePath) throw attachmentError('ATTACHMENT_PATH_INVALID', 'Attachment path is required');
  if (!isAbsolute(absolutePath)) throw attachmentError('ATTACHMENT_PATH_NOT_ABSOLUTE', 'Path must be absolute');

  const resolvedRoot = resolve(rootDir);
  const resolvedPath = resolve(absolutePath);
  const rel = relative(resolvedRoot, resolvedPath);

  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw attachmentError('ATTACHMENT_PATH_ESCAPE', 'Path must stay under attachment root');
  }

  return rel;
}

/**
 * Decide whether a picked file should be linked (already under attachmentRoot)
 * or uploaded (outside root → copy in). Pure decision; does no I/O.
 *
 * @param {string} rootDir attachment root absolute path
 * @param {{ relativePath?: string, absolutePath?: string }} [opts] one of these is required
 * @returns {{ mode: 'link', relativePath: string } | { mode: 'upload', absolutePath: string }}
 */
export function decideAttachmentMode(rootDir, { relativePath, absolutePath } = {}) {
  if (!rootDir) throw attachmentError('ATTACHMENT_PATH_INVALID', 'Attachment root is required');
  if (!relativePath && !absolutePath) {
    throw attachmentError('ATTACHMENT_PATH_INVALID', 'relativePath or absolutePath is required');
  }
  if (relativePath) {
    return { mode: 'link', relativePath };
  }
  // Narrowing: the earlier `!relativePath && !absolutePath` check threw if both
  // were missing, and we just returned when relativePath was set.
  const abs = /** @type {string} */ (absolutePath);
  if (!isAbsolute(abs)) {
    throw attachmentError('ATTACHMENT_PATH_NOT_ABSOLUTE', 'absolutePath must be absolute');
  }
  try {
    const rel = toAttachmentRelativePath(rootDir, abs);
    return { mode: 'link', relativePath: rel };
  } catch {
    return { mode: 'upload', absolutePath: abs };
  }
}

export function resolveAttachmentPathUnderRoot(rootDir, relativePath) {
  if (!rootDir) throw attachmentError('ATTACHMENT_PATH_INVALID', 'Attachment root is required');
  if (!relativePath) throw attachmentError('ATTACHMENT_PATH_INVALID', 'Attachment path is required');
  if (isAbsolute(relativePath)) throw attachmentError('ATTACHMENT_PATH_NOT_ABSOLUTE', 'Attachment path must be relative');

  const resolvedRoot = resolve(rootDir);
  const resolvedPath = resolve(resolvedRoot, relativePath);
  const rel = relative(resolvedRoot, resolvedPath);

  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw attachmentError('ATTACHMENT_PATH_ESCAPE', 'Attachment path must stay under attachment root');
  }

  return resolvedPath;
}

export function resolveAttachmentAbsolutePath(attachment, rootDir) {
  if (!attachment) {
    throw attachmentError('ATTACHMENT_NOT_FOUND', 'Attachment record missing');
  }
  if (attachment.storageMode === 'external') {
    const abs = attachment.absolutePath;
    if (!abs) throw attachmentError('ATTACHMENT_PATH_INVALID', 'External attachment missing absolutePath');
    if (!isAbsolute(abs)) throw attachmentError('ATTACHMENT_PATH_NOT_ABSOLUTE', 'External attachment absolutePath must be absolute');
    return resolve(abs);
  }
  return resolveAttachmentPathUnderRoot(rootDir, attachment.relativePath);
}

function assertUploadPreconditions({ buffer, originalFileName }) {
  if (!originalFileName) {
    throw attachmentError('ATTACHMENT_TYPE_REJECTED', 'Original file name is required');
  }
  if (!isAllowedAttachmentFileName(originalFileName)) {
    throw attachmentError('ATTACHMENT_TYPE_REJECTED', 'Attachment file type is not allowed');
  }
  if (buffer && buffer.length > ATTACHMENT_MAX_BYTES) {
    throw attachmentError('ATTACHMENT_TOO_LARGE', `Attachment exceeds maximum size of ${ATTACHMENT_MAX_BYTES} bytes`);
  }
}

const MAX_ATTACHMENT_NAME_ATTEMPTS = 1000;

function disambiguateAttachmentFileName(fileName, counter) {
  const ext = extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  return `${stem} (${counter})${ext}`;
}

/**
 * Write `buffer` into `dir` under `fileName`, never overwriting an existing
 * file. On collision it appends " (2)", " (3)"… until it finds a free name
 * (matching macOS/browser download behaviour) and returns the name actually
 * written. Two transactions that share a date and recipient derive the same
 * default file name, so this keeps both attachments instead of failing.
 */
async function writeAttachmentBufferUnique(dir, fileName, buffer) {
  await mkdir(dir, { recursive: true });
  for (let counter = 1; counter <= MAX_ATTACHMENT_NAME_ATTEMPTS; counter += 1) {
    const candidate = counter === 1 ? fileName : disambiguateAttachmentFileName(fileName, counter);
    try {
      await writeFile(resolve(dir, candidate), buffer, { flag: 'wx' });
      return candidate;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw attachmentError('ATTACHMENT_COLLISION', 'Unable to find a free attachment file name');
}

async function createExternalUploadedAttachmentRecord({ buffer, originalFileName, date, recipient, destinationFolder }) {
  assertUploadPreconditions({ buffer, originalFileName });

  const absoluteFolder = destinationFolder?.absolutePath;
  if (!absoluteFolder) {
    throw attachmentError('ATTACHMENT_PATH_INVALID', 'destinationFolder.absolutePath is required for external destination');
  }
  if (!isAbsolute(absoluteFolder)) {
    throw attachmentError('ATTACHMENT_PATH_NOT_ABSOLUTE', 'destinationFolder.absolutePath must be absolute');
  }

  const fileName = buildAttachmentFileName({ date, recipient, originalFileName });
  if (!isAllowedAttachmentFileName(fileName)) {
    throw attachmentError('ATTACHMENT_TYPE_REJECTED', 'Attachment file type is not allowed');
  }

  const finalName = await writeAttachmentBufferUnique(absoluteFolder, fileName, buffer);
  const targetAbsolutePath = resolve(absoluteFolder, finalName);

  const fileInfo = await stat(targetAbsolutePath);
  const now = new Date().toISOString();
  return {
    absolutePath: targetAbsolutePath,
    fileName: finalName,
    originalFileName,
    mimeType: inferAttachmentMimeType(originalFileName),
    size: fileInfo.size,
    linkedAt: now,
    updatedAt: now,
    status: 'unknown',
    lastVerifiedAt: null,
    storageMode: 'external',
  };
}

function composeUnderRootRelativePath({ date, recipient, originalFileName, relativePath, destinationFolder }) {
  if (relativePath) return relativePath;
  if (destinationFolder?.relativeFolder) {
    if (isAbsolute(destinationFolder.relativeFolder)) {
      throw attachmentError('ATTACHMENT_PATH_NOT_ABSOLUTE', 'destinationFolder.relativeFolder must be relative');
    }
    const fileName = buildAttachmentFileName({ date, recipient, originalFileName });
    return join(destinationFolder.relativeFolder, fileName);
  }
  return buildDefaultAttachmentRelativePath({ date, recipient, originalFileName });
}

/**
 * @param {string} rootDir
 * @param {{
 *   buffer: Buffer,
 *   originalFileName: string,
 *   date: string,
 *   recipient: string,
 *   relativePath?: string,
 *   destinationFolder?: { relativeFolder?: string, absolutePath?: string }
 * }} params
 */
export async function createUploadedAttachmentRecord(rootDir, { buffer, originalFileName, date, recipient, relativePath, destinationFolder }) {
  const externalRequested = !!(destinationFolder?.absolutePath) && !destinationFolder?.relativeFolder;
  if (externalRequested) {
    return createExternalUploadedAttachmentRecord({ buffer, originalFileName, date, recipient, destinationFolder });
  }

  assertUploadPreconditions({ buffer, originalFileName });

  const targetRelativePath = composeUnderRootRelativePath({
    date,
    recipient,
    originalFileName,
    relativePath,
    destinationFolder,
  });
  if (!isAllowedAttachmentFileName(targetRelativePath)) {
    throw attachmentError('ATTACHMENT_TYPE_REJECTED', 'Attachment file type is not allowed');
  }
  const resolvedPath = resolveAttachmentPathUnderRoot(rootDir, targetRelativePath);

  const finalName = await writeAttachmentBufferUnique(dirname(resolvedPath), basename(targetRelativePath), buffer);
  const finalRelativePath = join(dirname(targetRelativePath), finalName);
  const finalResolvedPath = resolve(dirname(resolvedPath), finalName);

  const fileInfo = await stat(finalResolvedPath);
  const now = new Date().toISOString();
  return {
    relativePath: finalRelativePath,
    fileName: finalName,
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
    throw attachmentError('ATTACHMENT_TYPE_REJECTED', 'Attachment file type is not allowed');
  }

  const fileInfo = await stat(resolvedPath);
  if (!fileInfo.isFile()) {
    throw attachmentError('ATTACHMENT_NOT_FILE', 'Attachment path must point to a file');
  }
  if (fileInfo.size > ATTACHMENT_MAX_BYTES) {
    throw attachmentError('ATTACHMENT_TOO_LARGE', `Attachment exceeds maximum size of ${ATTACHMENT_MAX_BYTES} bytes`);
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
    throw attachmentError('ATTACHMENT_PATH_INVALID', 'Old and new attachment paths are required');
  }
  if (!isAllowedAttachmentFileName(newRelativePath)) {
    throw attachmentError('ATTACHMENT_TYPE_REJECTED', 'Attachment file type is not allowed');
  }
  const oldResolved = resolveAttachmentPathUnderRoot(rootDir, oldRelativePath);
  const newResolved = resolveAttachmentPathUnderRoot(rootDir, newRelativePath);
  if (oldResolved === newResolved) return { moved: false };

  try {
    await access(newResolved);
    throw attachmentError('ATTACHMENT_COLLISION', 'Attachment destination already exists');
  } catch (err) {
    if (err.code === 'ATTACHMENT_COLLISION') throw err;
    if (err.code !== 'ENOENT') throw err;
  }

  await mkdir(dirname(newResolved), { recursive: true });
  await rename(oldResolved, newResolved);
  return { moved: true };
}

export async function relocateAttachment(rootDir, year, month, row, newRelativePath) {
  const existing = await getAttachment(year, month, row);
  if (!existing) {
    throw attachmentError('ATTACHMENT_NOT_FOUND', 'Attachment not found');
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

  if (!attachment) {
    return { status: 'unknown', lastVerifiedAt: now };
  }

  const isExternal = attachment.storageMode === 'external';
  if (isExternal ? !attachment.absolutePath : (!attachment.relativePath || !rootDir)) {
    return {
      ...attachment,
      status: 'unknown',
      lastVerifiedAt: now,
    };
  }

  let resolvedPath;
  try {
    resolvedPath = resolveAttachmentAbsolutePath(attachment, rootDir);
  } catch {
    return {
      ...attachment,
      status: 'unknown',
      lastVerifiedAt: now,
    };
  }

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
    if (next.status !== attachment?.status || next.lastVerifiedAt !== attachment?.lastVerifiedAt) {
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

/**
 * Find attachment records across years whose resolved absolute path matches
 * the given target. Optional exclude removes a specific (year, month, row) match.
 *
 * @param {string[]} years
 * @param {AttachmentRecord | null | undefined} targetAttachment
 * @param {string} rootDir attachment root
 * @param {{ exclude?: { year: string, key: string } }} [opts]
 */
export async function findAttachmentReferencesForRecord(years, targetAttachment, rootDir, { exclude } = {}) {
  if (!targetAttachment) return [];
  let targetAbs;
  try {
    targetAbs = resolveAttachmentAbsolutePath(targetAttachment, rootDir);
  } catch {
    return [];
  }

  const matches = [];
  for (const year of years) {
    const data = await readAll(year);
    for (const [key, attachment] of Object.entries(data.attachments)) {
      if (!attachment) continue;
      if (exclude && exclude.year === year && exclude.key === key) continue;
      let candidateAbs;
      try {
        candidateAbs = resolveAttachmentAbsolutePath(attachment, rootDir);
      } catch {
        continue;
      }
      if (candidateAbs !== targetAbs) continue;
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

/**
 * Re-key attachments after a compact renumbered a month's rows.
 * @param {Map<number, number>} oldToNewRowMap old row → new row; rows absent
 *   from the map were blank and removed, so their records are dropped.
 */
export async function shiftAttachmentsOnCompact(year, month, oldToNewRowMap) {
  return withLock(`attachments-${year}`, async () => {
    const data = await readAll(year);
    const prefix = `${month}-`;
    const toMove = [];
    for (const key of Object.keys(data.attachments)) {
      if (!key.startsWith(prefix)) continue;
      toMove.push({ oldRow: parseInt(key.slice(prefix.length), 10), value: data.attachments[key] });
      delete data.attachments[key];
    }
    for (const { oldRow, value } of toMove) {
      const newRow = oldToNewRowMap.get(oldRow);
      if (newRow != null) data.attachments[`${prefix}${newRow}`] = value;
    }
    await writeAll(year, data);
  });
}
