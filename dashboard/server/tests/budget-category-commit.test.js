import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

async function withTempDataDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'budget-commit-'));
  await mkdir(join(dir, '.gl-data'), { recursive: true });
  const project = await import('../services/project.js');
  // Import the services BEFORE redirecting the project dir. Their import chain
  // reaches `config.js`, which calls `bootstrap()` at module scope and reopens
  // the real project named in settings.json — silently undoing a setProjectDir
  // that ran first. That is not hypothetical: it sent this file's first test,
  // and only its first, at the developer's own .gl-data.
  const resolver = await import('../services/budgetCategoryResolver.js');
  const overrideMap = await import('../services/budgetCategoryMap.js');
  const previousProjectDir = project.getProjectDir();
  project.setProjectDir(dir);
  try {
    await fn({ dir, resolver, overrideMap });
  } finally {
    project.setProjectDir(previousProjectDir);
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeMapping(dir, mapping) {
  await writeFile(
    join(dir, '.gl-data', 'cf-budget-category-map.json'),
    JSON.stringify(mapping, null, 2),
    'utf8',
  );
}

async function readOverrideFile(dir, year) {
  try {
    const raw = await readFile(join(dir, '.gl-data', `transaction-budget-map-${year}.json`), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

test('skips Override write when choice matches the Mapping', async () => {
  await withTempDataDir(async ({ dir, resolver }) => {
    await writeMapping(dir, {
      'C-STIPENDI': { budgetCategory: 'Stipendi', budgetRow: 5 },
    });

    await resolver.commitBudgetCategoryChoice('2026', 'FEB', 30, 'C-STIPENDI', 'Stipendi', 5);

    const file = await readOverrideFile(dir, '2026');
    assert.deepEqual(file, {}, 'no Override entry should be written when choice matches Mapping');
  });
});

test('writes Override when choice differs from the Mapping', async () => {
  await withTempDataDir(async ({ dir, resolver }) => {
    await writeMapping(dir, {
      'C-STIPENDI': { budgetCategory: 'Stipendi', budgetRow: 5 },
    });

    await resolver.commitBudgetCategoryChoice('2026', 'FEB', 30, 'C-STIPENDI', 'Marketing', 8);

    const file = await readOverrideFile(dir, '2026');
    assert.deepEqual(file['FEB-30'], { category: 'Marketing', budgetRow: 8 });
  });
});

test('writes Override when CF Category has no Mapping entry', async () => {
  await withTempDataDir(async ({ dir, resolver }) => {
    await writeMapping(dir, {});

    await resolver.commitBudgetCategoryChoice(
      '2026',
      'MAR',
      47,
      'C-NEW-UNMAPPED',
      'UFFICIO - Affitto, Bollette, etc..',
      3,
    );

    const file = await readOverrideFile(dir, '2026');
    assert.deepEqual(file['MAR-47'], {
      category: 'UFFICIO - Affitto, Bollette, etc..',
      budgetRow: 3,
    });
  });
});

test('writes Override when Transaction has no CF Category', async () => {
  await withTempDataDir(async ({ dir, resolver }) => {
    await writeMapping(dir, {
      'C-STIPENDI': { budgetCategory: 'Stipendi', budgetRow: 5 },
    });

    await resolver.commitBudgetCategoryChoice('2026', 'MAR', 50, null, 'Marketing', 8);

    const file = await readOverrideFile(dir, '2026');
    assert.deepEqual(file['MAR-50'], { category: 'Marketing', budgetRow: 8 });
  });
});

test('deletes an existing redundant Override when a new commit matches the Mapping', async () => {
  await withTempDataDir(async ({ dir, resolver, overrideMap }) => {
    await writeMapping(dir, {
      'C-STIPENDI': { budgetCategory: 'Stipendi', budgetRow: 5 },
    });
    await overrideMap.setBudgetCategoryOverride('2026', 'FEB', 30, 'Stipendi', 5);

    let file = await readOverrideFile(dir, '2026');
    assert.ok(file['FEB-30'], 'precondition: an Override exists');

    await resolver.commitBudgetCategoryChoice('2026', 'FEB', 30, 'C-STIPENDI', 'Stipendi', 5);

    file = await readOverrideFile(dir, '2026');
    assert.equal(file['FEB-30'], undefined, 'redundant Override should be removed');
  });
});

test('deletes existing Override when budgetCategory is cleared (empty string)', async () => {
  await withTempDataDir(async ({ dir, resolver, overrideMap }) => {
    await writeMapping(dir, {});
    await overrideMap.setBudgetCategoryOverride('2026', 'FEB', 30, 'Marketing', 8);

    await resolver.commitBudgetCategoryChoice('2026', 'FEB', 30, 'C-STIPENDI', '', null);

    const file = await readOverrideFile(dir, '2026');
    assert.equal(file['FEB-30'], undefined);
  });
});

test('replaces a divergent Override with a new divergent value', async () => {
  await withTempDataDir(async ({ dir, resolver, overrideMap }) => {
    await writeMapping(dir, {
      'C-STIPENDI': { budgetCategory: 'Stipendi', budgetRow: 5 },
    });
    await overrideMap.setBudgetCategoryOverride('2026', 'FEB', 30, 'Marketing', 8);

    await resolver.commitBudgetCategoryChoice(
      '2026',
      'FEB',
      30,
      'C-STIPENDI',
      'Consulenze Commerciali',
      9,
    );

    const file = await readOverrideFile(dir, '2026');
    assert.deepEqual(file['FEB-30'], { category: 'Consulenze Commerciali', budgetRow: 9 });
  });
});
