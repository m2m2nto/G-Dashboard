// Settings → Database: how the location is described to the user.
import test from 'node:test';
import assert from 'node:assert/strict';

import { describeDatabaseLocation } from '../src/components/settings/databaseSection.js';

test('describeDatabaseLocation reports the configured location', () => {
  const view = describeDatabaseLocation({
    databaseDir: '/proj/.gl-data',
    isCustom: true,
    databaseExists: true,
  });
  assert.equal(view.path, '/proj/.gl-data');
  assert.equal(view.isCustom, true);
  assert.equal(view.exists, true);
});

test('describeDatabaseLocation tolerates a missing response', () => {
  const view = describeDatabaseLocation({});
  assert.equal(view.path, null);
  assert.equal(view.exists, false);
  assert.equal(view.isCustom, false);
});
