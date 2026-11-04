import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { installFatalHandlers, isBenignRejection } from '../src/fatal.js';

function setup() {
  const proc = new EventEmitter();
  const exits = [];
  const output = [];
  installFatalHandlers({
    proc,
    write: (t) => output.push(t),
    cleanupAndExit: async (code) => void exits.push(code),
  });
  return { proc, exits, output };
}

class OBSWebSocketError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

test('an uncaught exception logs the stack, runs cleanup and exits non-zero', () => {
  const { proc, exits, output } = setup();
  proc.emit('uncaughtException', new Error('boom'));
  assert.deepEqual(exits, [1]);
  assert.match(output.join(''), /boom/);
});

test('an unknown unhandled rejection is fatal too', () => {
  const { proc, exits } = setup();
  proc.emit('unhandledRejection', new TypeError('oops'));
  assert.deepEqual(exits, [1]);
});

test('an OBS websocket rejection is only a warning', () => {
  const { proc, exits, output } = setup();
  proc.emit('unhandledRejection', new OBSWebSocketError(3000, 'Connection closed'));
  assert.deepEqual(exits, []);
  assert.match(output.join(''), /session continues/);
});

test('isBenignRejection recognises only the OBS client error', () => {
  assert.equal(isBenignRejection(new OBSWebSocketError(1, 'x')), true);
  assert.equal(isBenignRejection(new Error('x')), false);
  assert.equal(isBenignRejection(undefined), false);
});
