/**
 * Pure helpers for the Database location section.
 */

/**
 * What to tell the user about where the database currently lives.
 *
 * @param {{ databaseDir?: string|null, defaultDatabaseDir?: string|null, isCustom?: boolean, databaseExists?: boolean }} info
 * @returns {{ path: string|null, isCustom: boolean, exists: boolean }}
 */
export function describeDatabaseLocation(info) {
  return {
    path: info?.databaseDir || null,
    isCustom: !!info?.isCustom,
    exists: !!info?.databaseExists,
  };
}
