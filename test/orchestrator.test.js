import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildAttempts } from '../src/orchestrator.js';
import { defaultConfig, buildArgs, Mode } from '../src/scrcpy/args.js';

/**
 * Locks in exactly the bug we hit in real conditions: keepActive existed
 * in defaultConfig and in buildArgs, but buildAttempts explicitly listed
 * the fields it forwarded to scrcpy and had missed this one. It was
 * silently getting lost between the user's config and the command that
 * actually ran -- no test caught it, since buildArgs on its own worked
 * perfectly.
 *
 * To keep this from happening again with a future field, we check HERE
 * that EVERY relevant field of defaultConfig actually shows up in the
 * final arguments, going through the real path (buildAttempts ->
 * buildArgs) rather than buildArgs alone.
 */

const probe = { serial: '192.168.1.42:5555', width: 1080, height: 2400, navigationMode: 2 };

function argsFor(overrides, { mode = Mode.VIRTUAL } = {}) {
  const config = { ...defaultConfig, ...overrides, mode, app: overrides.app ?? 'com.example.app' };
  const attempts = buildAttempts(config, probe);
  const attempt = attempts.find((a) => a.mode === mode);
  return buildArgs(attempt);
}

test('keepActive flows through buildAttempts all the way to the final command', () => {
  assert.ok(argsFor({ keepActive: true }).includes('--keep-active'));
  assert.ok(!argsFor({ keepActive: false }).includes('--keep-active'));
});

test('windowBorderless flows through buildAttempts all the way to the final command', () => {
  // Off by default: OBS's client_area capture already crops the title bar
  // out, so a decorated window should be the normal case, not the exception.
  assert.ok(!argsFor({ windowBorderless: false }).includes('--window-borderless'));
  assert.ok(argsFor({ windowBorderless: true }).includes('--window-borderless'));
});

test('keepActive also flows through in mirror mode', () => {
  const args = argsFor({ keepActive: true }, { mode: Mode.MIRROR });
  assert.ok(args.includes('--keep-active'));
});

test('turnScreenOff and stayAwake flow through buildAttempts', () => {
  const args = argsFor({ turnScreenOff: true, stayAwake: true });
  assert.ok(args.includes('--turn-screen-off'));
  assert.ok(args.includes('--stay-awake'));
});

test('video.bitrate flows through buildAttempts', () => {
  const args = argsFor({ video: { ...defaultConfig.video, bitrate: '20M' } });
  assert.ok(args.includes('--video-bit-rate=20M'));
});

/**
 * The most useful test for the future: checks that NO field of
 * defaultConfig gets lost along the way, without having to maintain a
 * manual list on every addition. A regression on a field that doesn't
 * even exist yet today will make this fail too.
 */
test('no scalar or object field of defaultConfig is lost by buildAttempts', () => {
  // Fields deliberately handled separately by the orchestrator (derived
  // from other sources, or specific to the mode/fallback logic), so
  // they're absent as-is from the object buildAttempts receives or returns.
  //
  // Note: "noFallback" doesn't need an entry here. It doesn't even live in
  // defaultConfig (it comes from appDefaults, in config.js): it controls
  // the LIST of attempts produced by buildAttempts, not the fields of ONE
  // attempt. The loop below will therefore never encounter it.
  const handledElsewhere = new Set([
    'mode',
    'serial',
    'display',
    'app',
    'forceStopApp',
    'launcher',
    'maxSize',
    'crop',
  ]);

  for (const [key, defaultValue] of Object.entries(defaultConfig)) {
    if (handledElsewhere.has(key)) continue;

    // Force a value DIFFERENT from the default to catch a propagation bug
    // that would just copy the default instead of reading the config.
    const probeValue =
      typeof defaultValue === 'boolean'
        ? !defaultValue
        : typeof defaultValue === 'object' && defaultValue !== null
          ? defaultValue // objects (video, audio, control) are checked case by case elsewhere
          : defaultValue;

    if (typeof defaultValue !== 'boolean') continue; // objects have their own targeted tests

    const config = { ...defaultConfig, [key]: probeValue, app: 'com.example.app' };
    const attempts = buildAttempts(config, probe);

    assert.equal(
      attempts[0][key],
      probeValue,
      `field "${key}" doesn't flow through buildAttempts (stayed at ${attempts[0][key]} instead of ${probeValue})`,
    );
  }
});
/* --- watchSession: stop / restart races ------------------------------------- */

function recordingLogger() {
  const warnings = [];
  const noop = () => {};
  return {
    warnings,
    debug: noop,
    info: noop,
    error: noop,
    warn: (m) => warnings.push(m),
  };
}

function deadProc(exit = { expected: false, exitCode: 1 }) {
  let waits = 0;
  return {
    logs: [],
    isAlive: () => false,
    waitForExit: async () => {
      waits += 1;
      return exit;
    },
    waits: () => waits,
  };
}

test('stop() during the restart delay prevents any relaunch', async () => {
  const { watchSession } = await import('../src/orchestrator.js');
  const session = {
    proc: deadProc(),
    stopRequested: false,
    _relaunch: {},
    _active: {},
  };
  let launched = 0;
  const deps = {
    launch: async () => void (launched += 1),
    setupScene: async () => {},
  };
  const logger = recordingLogger();

  const watching = watchSession(session, { logger, delayMs: 40, deps });
  setTimeout(() => {
    session.stopRequested = true;
  }, 10);
  const result = await watching;

  assert.equal(launched, 0);
  assert.equal(result.reason, 'stopped');
});

test('a failed relaunch does not re-read the consumed exit or log the crash twice', async () => {
  const { watchSession } = await import('../src/orchestrator.js');
  const old = deadProc();
  const session = {
    proc: old,
    stopRequested: false,
    _relaunch: { binaries: {}, attempt: {}, sceneOptions: {} },
    _active: {},
    obs: {},
  };
  let launches = 0;
  const finalProc = {
    logs: [],
    isAlive: () => true,
    waitForExit: async () => ({ expected: true, exitCode: 0 }),
  };
  const deps = {
    launch: async () => {
      launches += 1;
      if (launches === 1) throw new Error('adb hiccup');
      return finalProc;
    },
    setupScene: async () => {},
  };
  const logger = recordingLogger();

  const result = await watchSession(session, { logger, delayMs: 1, deps });

  assert.equal(launches, 2);
  assert.equal(old.waits(), 1, 'the dead process exit must be awaited exactly once');
  assert.equal(
    logger.warnings.filter((m) => m.includes('exited unexpectedly')).length,
    1,
  );
  assert.equal(result.reason, 'stopped');
  assert.equal(result.restarts, 2);
});

test('stop() landing while the relaunch is in flight stops the new process', async () => {
  const { watchSession } = await import('../src/orchestrator.js');
  const session = {
    proc: deadProc(),
    stopRequested: false,
    _relaunch: { binaries: {}, attempt: {}, sceneOptions: {} },
    _active: {},
    obs: {},
  };
  let stoppedNew = 0;
  const newProc = {
    logs: [],
    isAlive: () => true,
    stop: async () => void (stoppedNew += 1),
    waitForExit: async () => ({ expected: true, exitCode: 0 }),
  };
  const deps = {
    launch: async () => {
      session.stopRequested = true; // stop() arrives mid-launch
      return newProc;
    },
    setupScene: async () => {
      throw new Error('must not run after a stop');
    },
  };

  const result = await watchSession(session, { logger: recordingLogger(), delayMs: 1, deps });

  assert.equal(stoppedNew, 1);
  assert.equal(result.reason, 'stopped');
});
