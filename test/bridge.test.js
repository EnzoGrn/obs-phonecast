import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBridge } from '../src/server/bridge.js';

/** Collects every broadcast message, in order. */
function collector() {
  const messages = [];
  return { broadcast: (m) => messages.push(m), messages };
}

/**
 * A fake orchestrator: startSession resolves immediately to a controllable
 * fake session, watchSession resolves only once that session's stop() is
 * called -- close enough to the real shape to exercise the bridge's state
 * machine without a phone, OBS, or execa.
 */
function fakeOrchestratorDeps({ startSessionImpl = null } = {}) {
  let resolveWatch;
  const watchPromise = new Promise((r) => {
    resolveWatch = r;
  });

  const session = {
    mode: 'virtual',
    stop: async () => {
      resolveWatch({ reason: 'stopped', exitCode: 0, restarts: 0 });
    },
  };

  return {
    loadOrchestrator: async () => ({
      startSession: startSessionImpl ?? (async () => session),
      watchSession: async () => watchPromise,
    }),
    loadAdb: async () => ({ pickDevice: async () => ({ serial: 'fake-serial' }) }),
    loadBinary: async () => ({ resolveBinaries: async () => ({}) }),
    loadApps: async () => ({
      listApps: async () => ({ apps: [{ name: 'YouTube', package: 'com.example', system: false }] }),
    }),
  };
}

test('status starts idle', () => {
  const { broadcast } = collector();
  const bridge = createBridge({ broadcast, deps: fakeOrchestratorDeps() });
  assert.equal(bridge.status(), 'idle');
});

test('start flips status to running and broadcasts it', async () => {
  const { broadcast, messages } = collector();
  const bridge = createBridge({ broadcast, deps: fakeOrchestratorDeps() });

  await bridge.start({ app: 'youtube' });

  assert.equal(bridge.status(), 'running');
  assert.deepEqual(
    messages.filter((m) => m.type === 'status'),
    [
      { type: 'status', state: 'starting' },
      { type: 'status', state: 'running', mode: 'virtual' },
    ],
  );
});

test('starting twice while already running is rejected', async () => {
  const { broadcast } = collector();
  const bridge = createBridge({ broadcast, deps: fakeOrchestratorDeps() });

  await bridge.start({});
  await assert.rejects(() => bridge.start({}), /already running/);
});

test('stop while idle is a harmless no-op', async () => {
  const { broadcast, messages } = collector();
  const bridge = createBridge({ broadcast, deps: fakeOrchestratorDeps() });

  await bridge.stop();

  assert.equal(bridge.status(), 'idle');
  assert.equal(messages.length, 0);
});

test('stop flips status back to idle and broadcasts the reason', async () => {
  const { broadcast, messages } = collector();
  const bridge = createBridge({ broadcast, deps: fakeOrchestratorDeps() });

  await bridge.start({});
  await bridge.stop();

  assert.equal(bridge.status(), 'idle');
  const statusMessages = messages.filter((m) => m.type === 'status');
  assert.equal(statusMessages.length, 3); // starting, running, then idle
  assert.deepEqual(statusMessages[2], { type: 'status', state: 'idle', reason: 'stopped' });
});

test('a new dock client gets replayed the log history', async () => {
  const { broadcast } = collector();
  const bridge = createBridge({ broadcast, deps: fakeOrchestratorDeps() });

  bridge.logger.info('first message');
  bridge.logger.warn('second message');

  const replayed = [];
  bridge.replayHistoryTo((m) => replayed.push(m));

  assert.equal(replayed.length, 2);
  assert.equal(replayed[0].record.message, 'first message');
  assert.equal(replayed[1].record.level, 'warn');
});

test('listApps forwards through the injected adb/scrcpy layer', async () => {
  const { broadcast } = collector();
  const bridge = createBridge({ broadcast, deps: fakeOrchestratorDeps() });

  const result = await bridge.listApps();

  assert.equal(result.apps.length, 1);
  assert.equal(result.apps[0].name, 'YouTube');
});

test('start({ audio: true }) reaches startSession as audio.enabled: true', async () => {
  // Locks in the whole chain: dock checkbox -> WebSocket message ->
  // bridge.start -> config override -> the config startSession actually
  // receives. Easy to break silently at any one of those hops (as
  // keepActive already did once, in buildAttempts).
  let receivedConfig = null;
  const deps = fakeOrchestratorDeps({
    startSessionImpl: async (config) => {
      receivedConfig = config;
      return { mode: 'virtual', stop: async () => {} };
    },
  });
  const { broadcast } = collector();
  const bridge = createBridge({ broadcast, deps });

  await bridge.start({ audio: true });

  assert.equal(receivedConfig.audio.enabled, true);
});

test('start() with no audio option leaves audio at its default (disabled)', async () => {
  let receivedConfig = null;
  const deps = fakeOrchestratorDeps({
    startSessionImpl: async (config) => {
      receivedConfig = config;
      return { mode: 'virtual', stop: async () => {} };
    },
  });
  const { broadcast } = collector();
  const bridge = createBridge({ broadcast, deps });

  await bridge.start({});

  assert.equal(receivedConfig.audio.enabled, false);
});

test('a failed start leaves the bridge idle, not stuck', async () => {
  const { broadcast, messages } = collector();
  const deps = fakeOrchestratorDeps({
    startSessionImpl: async () => {
      throw new Error('no device attached');
    },
  });
  const bridge = createBridge({ broadcast, deps });

  await assert.rejects(() => bridge.start({}), /no device attached/);

  // The critical bit: a failure during start() must not leave `session`
  // set, or every future start() would wrongly report "already running".
  assert.equal(bridge.status(), 'idle');
  assert.ok(!messages.some((m) => m.type === 'status' && m.state === 'running'));
});

/* --- getConfig / saveConfig ------------------------------------------------ */

test('getConfig reads the config file at the given path', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;

  const dir = await mkdtemp(path.join(tmpdir(), 'obs-phonecast-bridge-'));
  try {
    const target = path.join(dir, 'obs-phonecast.json');
    await writeFile(target, JSON.stringify({ app: 'spotify' }));

    const { broadcast } = collector();
    const bridge = createBridge({ broadcast, deps: fakeOrchestratorDeps(), configFile: target });

    const config = await bridge.getConfig();
    assert.deepEqual(config, { app: 'spotify' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('saveConfig writes to the same path getConfig reads from', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;

  const dir = await mkdtemp(path.join(tmpdir(), 'obs-phonecast-bridge-'));
  try {
    const target = path.join(dir, 'nested', 'obs-phonecast.json');
    const { broadcast } = collector();
    const bridge = createBridge({ broadcast, deps: fakeOrchestratorDeps(), configFile: target });

    await bridge.saveConfig({ obs: { password: 'x' } });

    const written = JSON.parse(await readFile(target, 'utf8'));
    assert.deepEqual(written, { obs: { password: 'x' } });

    const readBack = await bridge.getConfig();
    assert.deepEqual(readBack, written);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
/* --- starting state: concurrency and cancellation --------------------------- */

/** startSession that stays pending until release() is called. */
function slowStart() {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const calls = [];
  let stopped = 0;
  let resolveWatch;
  const watchPromise = new Promise((r) => {
    resolveWatch = r;
  });
  const session = {
    mode: 'virtual',
    stop: async () => {
      stopped += 1;
      resolveWatch({ reason: 'stopped' });
    },
  };
  const deps = {
    ...fakeOrchestratorDeps(),
    loadOrchestrator: async () => ({
      startSession: async () => {
        calls.push(1);
        await gate;
        return session;
      },
      watchSession: async () => watchPromise,
    }),
  };
  return { deps, release, calls, stoppedCount: () => stopped };
}

test('two concurrent start() calls launch exactly one session', async () => {
  const { broadcast } = collector();
  const slow = slowStart();
  const bridge = createBridge({ broadcast, deps: slow.deps });

  const first = bridge.start({});
  assert.equal(bridge.status(), 'starting');
  await assert.rejects(() => bridge.start({}), /already running/);

  slow.release();
  await first;

  assert.equal(slow.calls.length, 1);
  assert.equal(bridge.status(), 'running');
});

test('stop() during startup stops the session as soon as it is up', async () => {
  const { broadcast, messages } = collector();
  const slow = slowStart();
  const bridge = createBridge({ broadcast, deps: slow.deps });

  const starting = bridge.start({});
  const stopping = bridge.stop();
  slow.release();
  await Promise.all([starting, stopping]);

  assert.equal(slow.stoppedCount(), 1);
  assert.equal(bridge.status(), 'idle');
  const states = messages.filter((m) => m.type === 'status').map((m) => m.state);
  assert.deepEqual(states, ['starting', 'idle']);
});

test('a failed startSession returns the bridge to idle and can be retried', async () => {
  const { broadcast, messages } = collector();
  const deps = fakeOrchestratorDeps({
    startSessionImpl: async () => {
      throw new Error('no device');
    },
  });
  const bridge = createBridge({ broadcast, deps });

  await assert.rejects(() => bridge.start({}), /no device/);

  assert.equal(bridge.status(), 'idle');
  assert.equal(messages.at(-1).state, 'idle');
});

test('a watchSession rejection resets the bridge to idle', async () => {
  const { broadcast, messages } = collector();
  const deps = {
    ...fakeOrchestratorDeps(),
    loadOrchestrator: async () => ({
      startSession: async () => ({ mode: 'virtual', stop: async () => {} }),
      watchSession: async () => {
        throw new Error('watcher blew up');
      },
    }),
  };
  const bridge = createBridge({ broadcast, deps });

  await bridge.start({});
  // Let the rejection handler run.
  await new Promise((r) => setImmediate(r));

  assert.equal(bridge.status(), 'idle');
  assert.deepEqual(messages.at(-1), { type: 'status', state: 'idle', reason: 'error' });
});

test('saveConfig rejects an invalid config and leaves the file alone', async () => {
  const { mkdtemp, rm, access } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-cfg-'));
  const file = path.join(dir, 'obs-phonecast.json');
  try {
    const { broadcast } = collector();
    const bridge = createBridge({ broadcast, deps: fakeOrchestratorDeps(), configFile: file });

    await assert.rejects(() => bridge.saveConfig({ obs: { port: 'abc' } }), /obs\.port/);
    await assert.rejects(() => access(file), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
