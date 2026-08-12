/**
 * Pure helpers for the Settings dialog's side menu.
 *
 * The panes are mutually exclusive, so a problem in a pane the user is not
 * looking at would otherwise be invisible. Each menu entry therefore carries the
 * worst status of the fields it contains.
 */

/**
 * Worst status of a single file field, mirroring FileSection's status icon.
 *
 * @param {boolean|undefined} status
 * @param {string[]|undefined} problems
 * @returns {'error'|'warning'|null}
 */
function fileBadge(status, problems) {
  if (status === false) return 'error';
  if (problems?.length > 0) return 'warning';
  return null;
}

/**
 * Worst badge of a set, error outranking warning.
 *
 * @param {Array<'error'|'warning'|null>} badges
 * @returns {'error'|'warning'|null}
 */
function worst(badges) {
  if (badges.includes('error')) return 'error';
  if (badges.includes('warning')) return 'warning';
  return null;
}

/**
 * The side-menu entries, in display order, for the current manifest version.
 *
 * @param {{
 *   isV2: boolean,
 *   fileStatus?: Record<string, boolean|undefined>,
 *   fileProblems?: Record<string, string[]|undefined>,
 *   txFileStatus?: Record<string, boolean|undefined>,
 *   txFileProblems?: Record<string, string[]|undefined>,
 * }} params
 * @returns {Array<{ id: string, label: string, icon: string, badge: 'error'|'warning'|null }>}
 */
export function buildSettingsSections({
  isV2,
  fileStatus = {},
  fileProblems = {},
  txFileStatus = {},
  txFileProblems = {},
}) {
  const sections = [
    { id: 'project', label: 'Project', icon: 'folder', badge: null },
    {
      id: 'attachments',
      label: 'Attachment Root',
      icon: 'attach_file',
      badge: fileBadge(fileStatus.attachmentRoot, fileProblems.attachmentRoot),
    },
    {
      id: 'cashflow',
      label: 'Cash Flow File',
      icon: 'monitoring',
      badge: fileBadge(fileStatus.cashFlowFile, fileProblems.cashFlowFile),
    },
  ];

  if (isV2) {
    sections.push({
      id: 'budget',
      label: 'Budget File',
      icon: 'account_balance',
      badge: fileBadge(fileStatus.budgetFile, fileProblems.budgetFile),
    });
    sections.push({
      id: 'transactions',
      label: 'Transaction Files',
      icon: 'description',
      badge: worst(
        Object.keys({ ...txFileStatus, ...txFileProblems }).map((year) =>
          fileBadge(txFileStatus[year], txFileProblems[year])),
      ),
    });
  } else {
    sections.push({
      id: 'transactions',
      label: 'Transaction Files',
      icon: 'description',
      badge: worst([
        fileBadge(fileStatus.bankingFile, fileProblems.bankingFile),
        fileBadge(fileStatus.archiveDir, fileProblems.archiveDir),
      ]),
    });
  }

  sections.push({ id: 'database', label: 'Database', icon: 'database', badge: null });
  return sections;
}

/**
 * The section to show: the requested one when it still exists, else the first.
 *
 * Sections come and go with the manifest version, so a remembered id can point
 * at a pane that is no longer offered.
 *
 * @param {Array<{ id: string }>} sections
 * @param {string} requestedId
 * @returns {string}
 */
export function resolveActiveSection(sections, requestedId) {
  return sections.some((s) => s.id === requestedId) ? requestedId : sections[0].id;
}
