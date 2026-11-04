import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createCleanupManager } from '../src/scrcpy/process.js';

function setup(options = {}) {
  const host = new EventEmitter();
  const exits = [];
  const manager = createCleanupManager({ proc: host, exit: (c) => exits.push(c), ...options });
  return { host, exits, manager };
}

const tick = () => new Promise((r) => setImmediate(r));

test('SIGINT runs the async hook before exiting', async () => {
  const { host, exits, manager } = setup();
  const order = [];
  manager.register(() => [], {
    hook: async () => {
      await tick();
      order.push('restored');
    },
  });

  host.emit('SIGINT');
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(order, ['restored']);
  assert.deepEqual(exits, [130]);
});

test('SIGTERM exits 143 and also stops live processes', async () => {
  const { host, exits, manager } = setup();
  let stopped = 0;
  const proc = { isAlive: () => true, stop: async () => void (stopped += 1) };
  manager.register(() => [proc]);

  host.emit('SIGTERM');
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(stopped, 1);
  assert.deepEqual(exits, [143]);
});

test('a hook that never settles cannot block the exit (global timeout)', async () => {
  const { host, exits, manager } = setup({ timeoutMs: 30 });
  manager.register(() => [], { hook: () => new Promise(() => {}) });

  host.emit('SIGINT');
  await new Promise((r) => setTimeout(r, 80));

  assert.deepEqual(exits, [130]);
});

test('a throwing hook does not prevent the exit', async () => {
  const { host, exits, manager } = setup();
  manager.register(() => [], {
    hook: async () => {
      throw new Error('adb gone');
    },
  });

  host.emit('SIGINT');
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(exits, [130]);
});

test('listeners are installed once, however many sessions register', () => {
  const { host, manager } = setup();
  for (let i = 0; i < 5; i += 1) manager.register(() => [])();

  assert.equal(host.listenerCount('SIGINT'), 1);
  assert.equal(host.listenerCount('SIGTERM'), 1);
  assert.equal(host.listenerCount('exit'), 1);
});

test('an unregistered session no longer has its hook run', async () => {
  const { host, exits, manager } = setup();
  let ran = false;
  const unregister = manager.register(() => [], {
    hook: async () => {
      ran = true;
    },
  });
  unregister();
  assert.equal(manager.size(), 0);

  host.emit('SIGINT');
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(ran, false);
  assert.deepEqual(exits, [130]);
});

test('shutdown(code) runs the hooks then exits with that code (fatal errors)', async () => {
  const { exits, manager } = setup();
  let ran = false;
  manager.register(() => [], { hook: async () => void (ran = true) });

  await manager.shutdown(1);

  assert.equal(ran, true);
  assert.deepEqual(exits, [1]);
});
