import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshElementSlices } from '../src/elementsRefresh.js';

function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('passes names from getElements into setElements', async () => {
  const names = ['ALPHA', 'BETA', 'GAMMA'];
  const calls = { getElements: 0, loadElements: 0, setElements: [] };
  await refreshElementSlices({
    getElements: async () => { calls.getElements += 1; return names; },
    loadElements: async () => { calls.loadElements += 1; },
    setElements: (v) => { calls.setElements.push(v); },
  });
  assert.equal(calls.getElements, 1);
  assert.deepEqual(calls.setElements, [names]);
});

test('also calls loadElements (refreshes elementsDetail slice)', async () => {
  const calls = { loadElements: 0 };
  await refreshElementSlices({
    getElements: async () => [],
    loadElements: async () => { calls.loadElements += 1; },
    setElements: () => {},
  });
  assert.equal(calls.loadElements, 1);
});

test('rejection from getElements propagates and setElements is not called', async () => {
  const setCalls = [];
  await assert.rejects(
    () => refreshElementSlices({
      getElements: async () => { throw new Error('boom'); },
      loadElements: async () => {},
      setElements: (v) => { setCalls.push(v); },
    }),
    /boom/,
  );
  assert.deepEqual(setCalls, []);
});

test('getElements and loadElements both start before either resolves (parallel)', async () => {
  const ge = makeDeferred();
  const le = makeDeferred();
  let geStarted = false;
  let leStarted = false;
  const p = refreshElementSlices({
    getElements: () => { geStarted = true; return ge.promise.then(() => []); },
    loadElements: () => { leStarted = true; return le.promise; },
    setElements: () => {},
  });
  await Promise.resolve();
  assert.equal(geStarted, true, 'getElements must start before either resolves');
  assert.equal(leStarted, true, 'loadElements must start before either resolves');
  ge.resolve();
  le.resolve();
  await p;
});
