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

/* --- --dock-host on a LAN address ------------------------------------------- */

const LAN = { host: '192.168.1.20', hostHeader: '192.168.1.20:7412' };

test('the configured LAN host is accepted as an origin', () => {
  assert.equal(isAllowedOrigin('http://192.168.1.20:7412', 7412, LAN), true);
});

test('a LAN origin is still rejected without a matching --dock-host', () => {
  assert.equal(isAllowedOrigin('http://192.168.1.20:7412', 7412), false);
});

test('a different port on the configured LAN host is rejected', () => {
  assert.equal(isAllowedOrigin('http://192.168.1.20:9999', 7412, LAN), false);
});

test('a third-party site is still rejected when a LAN host is configured', () => {
  assert.equal(isAllowedOrigin('https://evil.example.com', 7412, LAN), false);
  assert.equal(isAllowedOrigin('http://192.168.1.99:7412', 7412, LAN), false);
});

test('loopback stays allowed alongside a configured LAN host', () => {
  assert.equal(isAllowedOrigin('http://localhost:7412', 7412, { ...LAN, hostHeader: 'localhost:7412' }), true);
});

test('a Host header that does not match is rejected (DNS rebinding)', () => {
  // The rebinding page is same-origin with itself, so Origin alone passes.
  const rebind = { host: '127.0.0.1', hostHeader: 'evil.example.com:7412' };
  assert.equal(isAllowedOrigin('http://evil.example.com:7412', 7412, rebind), false);
  assert.equal(isAllowedOrigin(undefined, 7412, rebind), false);
});

test('Host header with the wrong port is rejected', () => {
  assert.equal(isAllowedOrigin(undefined, 7412, { host: '127.0.0.1', hostHeader: '127.0.0.1:80' }), false);
});

test('wildcard bind: origin must match the Host header and be an IP literal', () => {
  const wild = { host: '0.0.0.0', hostHeader: '192.168.1.20:7412' };
  assert.equal(isAllowedOrigin('http://192.168.1.20:7412', 7412, wild), true);
  // Origin from a different address than the one the request was sent to.
  assert.equal(isAllowedOrigin('http://192.168.1.77:7412', 7412, wild), false);
  // A DNS name is what a rebinding attack uses.
  const named = { host: '0.0.0.0', hostHeader: 'evil.example.com:7412' };
  assert.equal(isAllowedOrigin('http://evil.example.com:7412', 7412, named), false);
});

test('IPv6 wildcard bind accepts an IPv6 literal Host', () => {
  const wild = { host: '::', hostHeader: '[fd00::5]:7412' };
  assert.equal(isAllowedOrigin('http://[fd00::5]:7412', 7412, wild), true);
});
