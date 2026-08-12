// @ts-check
import { isAbsolute } from 'path';
import { getDb } from './db.js';

/**
 * Remembered attachment destinations, in the `folder_memory` table
 * (tasks/plan.md T21). `attachment-folder-memory.json` is a frozen archive:
 * imported once at startup, then never read or written again.
 *
 * The exported API and its return shapes are unchanged from the JSON version —
 * `routes/attachments.js` cannot tell the two apart. The functions stay async
 * for the same reason.
 */

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

function getRow(key) {
  return /** @type {any} */ (getDb().prepare('SELECT * FROM folder_memory WHERE key = ?').get(key));
}

/** Rebuild the record in the shape the JSON store returned it. */
function recordFromRow(row) {
  const record = {};
  if (row.absolute_path != null) {
    record.absolutePath = row.absolute_path;
    record.relativeFolder = row.relative_folder ?? null;
    record.updatedAt = row.updated_at || null;
  }
  if (row.file_dir != null) {
    record.fileDir = row.file_dir;
    record.fileDirUpdatedAt = row.file_dir_updated_at || null;
  }
  return record;
}

export async function getRememberedDestinationFolder(recipient, type) {
  const key = buildKey(recipient, type);
  if (!key) return null;
  const row = getRow(key);
  if (!row) return null;
  const folder = normalizeFolder({ absolutePath: row.absolute_path, relativeFolder: row.relative_folder });
  return folder ? { ...folder, updatedAt: row.updated_at || null } : null;
}

export async function setRememberedDestinationFolder(recipient, folder, type) {
  const key = buildKey(recipient, type);
  if (!key) throw new Error('recipient is required');
  const normalized = normalizeFolder(folder);
  if (!normalized) throw new Error('absolutePath must be an absolute path');
  getDb().prepare(`
    INSERT INTO folder_memory (key, absolute_path, relative_folder, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      absolute_path   = excluded.absolute_path,
      relative_folder = excluded.relative_folder,
      updated_at      = excluded.updated_at
  `).run(key, normalized.absolutePath, normalized.relativeFolder, new Date().toISOString());
  return recordFromRow(getRow(key));
}

export async function clearRememberedDestinationFolder(recipient, type) {
  const key = buildKey(recipient, type);
  if (!key) return { ok: true };
  const row = getRow(key);
  if (row) {
    // Drop only the folder fields; keep any remembered file directory.
    if (row.file_dir != null) {
      getDb().prepare(`
        UPDATE folder_memory
        SET absolute_path = NULL, relative_folder = NULL, updated_at = NULL
        WHERE key = ?
      `).run(key);
    } else {
      getDb().prepare('DELETE FROM folder_memory WHERE key = ?').run(key);
    }
  }
  return { ok: true };
}

export async function getRememberedFileDirectory(recipient, type) {
  const key = buildKey(recipient, type);
  if (!key) return null;
  const row = getRow(key);
  const fileDir = normalizeDir(row?.file_dir);
  return fileDir ? { absolutePath: fileDir, updatedAt: row.file_dir_updated_at || null } : null;
}

export async function setRememberedFileDirectory(recipient, absolutePath, type) {
  const key = buildKey(recipient, type);
  if (!key) throw new Error('recipient is required');
  const fileDir = normalizeDir(absolutePath);
  if (!fileDir) throw new Error('absolutePath must be an absolute path');
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO folder_memory (key, file_dir, file_dir_updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      file_dir            = excluded.file_dir,
      file_dir_updated_at = excluded.file_dir_updated_at
  `).run(key, fileDir, now);
  return { absolutePath: fileDir, updatedAt: now };
}

export const __test = { normalizeFolder, normalizeRecipient, normalizeDir, buildKey };
