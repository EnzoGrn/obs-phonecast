import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAllowedOrigin } from '../src/server/index.js';

/**
 * Locks in the security boundary described in server/index.js: a
 * WebSocket handshake is not subject to the same-origin policy the way a
 * fetch() is, so this check is the only thing standing between "the dock
 * page we serve" and "any other webpage open in the same browser."
 */

test('no Origin header at all is allowed (non-browser clients: our tests, a raw ws client)', () => {
  assert.equal(isAllowedOrigin(undefined, 7412), true);
});

test('the dock\'s own origin is allowed', () => {
  assert.equal(isAllowedOrigin('http://127.0.0.1:7412', 7412), true);
  assert.equal(isAllowedOrigin('http://localhost:7412', 7412), true);
});

test('a mismatched port on an otherwise-local origin is rejected', () => {
  // Another local server on a different port is still a different origin
  // as far as this dock is concerned.
  assert.equal(isAllowedOrigin('http://localhost:9999', 7412), false);
});

test('a third-party website is rejected -- this is the actual attack this guards against', () => {
  assert.equal(isAllowedOrigin('https://evil.example.com', 7412), false);
});

test('a malformed Origin header is rejected, not thrown on', () => {
  assert.equal(isAllowedOrigin('not a url', 7412), false);
});

test('IPv6 loopback is recognized', () => {
  assert.equal(isAllowedOrigin('http://[::1]:7412', 7412), true);
});
