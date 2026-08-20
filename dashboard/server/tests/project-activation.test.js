import test from 'node:test';
import assert from 'node:assert/strict';

import { acquireProjectAccess } from '../services/projectActivation.js';

test('Project activation waits for readers and blocks later API requests', async () => {
  const releaseReader = await acquireProjectAccess();
  let writerEntered = false;
  let laterReaderEntered = false;

  const writer = acquireProjectAccess({ exclusive: true }).then((release) => {
    writerEntered = true;
    return release;
  });
  const laterReader = acquireProjectAccess().then((release) => {
    laterReaderEntered = true;
    return release;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writerEntered, false);
  assert.equal(laterReaderEntered, false, 'a reader queued behind activation must not pass it');

  releaseReader();
  const releaseWriter = await writer;
  assert.equal(writerEntered, true);
  assert.equal(laterReaderEntered, false);

  releaseWriter();
  const releaseLaterReader = await laterReader;
  assert.equal(laterReaderEntered, true);
  releaseLaterReader();
});

test('ordinary API requests retain concurrent read access', async () => {
  const first = await acquireProjectAccess();
  const second = await acquireProjectAccess();
  first();
  second();
});
