import test from 'node:test';
import assert from 'node:assert/strict';
import { getListenHost, isAllowedLocalOrigin } from '../services/httpSecurity.js';

test('isAllowedLocalOrigin allows same-origin requests without an Origin header', () => {
  assert.equal(isAllowedLocalOrigin(undefined), true);
  assert.equal(isAllowedLocalOrigin(''), true);
});

test('isAllowedLocalOrigin allows localhost development origins', () => {
  assert.equal(isAllowedLocalOrigin('http://localhost:5173'), true);
  assert.equal(isAllowedLocalOrigin('http://127.0.0.1:5173'), true);
  assert.equal(isAllowedLocalOrigin('http://[::1]:5173'), true);
});

test('isAllowedLocalOrigin rejects non-local origins', () => {
  assert.equal(isAllowedLocalOrigin('https://evil.example'), false);
  assert.equal(isAllowedLocalOrigin('http://192.168.1.50:5173'), false);
  assert.equal(isAllowedLocalOrigin('not a url'), false);
});

test('getListenHost defaults to loopback only', () => {
  const previous = process.env.HOST;
  delete process.env.HOST;
  try {
    assert.equal(getListenHost(), '127.0.0.1');
  } finally {
    if (previous === undefined) delete process.env.HOST;
    else process.env.HOST = previous;
  }
});
