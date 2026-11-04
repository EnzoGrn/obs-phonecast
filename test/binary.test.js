import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { resolveOne } from '../src/scrcpy/binary.js';

const EXE = process.platform === 'win32' ? '.exe' : '';

/** Injected filesystem + PATH lookup: no real binaries needed. */
function world({ files = [], pathLookup = {} } = {}) {
  const set = new Set(files);
  return {
    exists: (p) => set.has(p),
    which: async (name) => pathLookup[name] ?? null,
  };
}

test('a path from the environment is used but NOT marked bundled', async () => {
  const custom = path.join('opt', 'tools', `scrcpy${EXE}`);
  const result = await resolveOne('scrcpy', 'X_SCRCPY', {
    env: { X_SCRCPY: custom },
    root: path.join('app'),
    ...world({ files: [custom] }),
  });
  assert.deepEqual(result, { path: custom, bundled: false });
});

test('the vendor/ copy is the one that counts as bundled', async () => {
  const root = path.join('app');
  const vendored = path.join(root, 'vendor', 'scrcpy', process.platform, `scrcpy${EXE}`);
  const result = await resolveOne('scrcpy', 'X_SCRCPY', {
    env: {},
    root,
    ...world({ files: [vendored] }),
  });
  assert.deepEqual(result, { path: vendored, bundled: true });
});

test('an env value without a directory is looked up in PATH', async () => {
  const result = await resolveOne('scrcpy', 'X_SCRCPY', {
    env: { X_SCRCPY: 'scrcpy' },
    root: path.join('app'),
    ...world({ pathLookup: { scrcpy: '/usr/local/bin/scrcpy' } }),
  });
  assert.deepEqual(result, { path: '/usr/local/bin/scrcpy', bundled: false });
});

test('adb next to the scrcpy we found wins over the one in PATH', async () => {
  const scrcpyPath = path.join('opt', 'scrcpy', `scrcpy${EXE}`);
  const sibling = path.join('opt', 'scrcpy', `adb${EXE}`);
  const result = await resolveOne('adb', 'X_ADB', {
    env: {},
    root: path.join('app'),
    alongside: scrcpyPath,
    ...world({ files: [sibling], pathLookup: { [`adb${EXE}`]: '/usr/bin/adb' } }),
  });
  assert.deepEqual(result, { path: sibling, bundled: false });
});

test('falls back to PATH, and to null when nothing is found', async () => {
  const found = await resolveOne('adb', 'X_ADB', {
    env: {},
    root: path.join('app'),
    ...world({ pathLookup: { [`adb${EXE}`]: '/usr/bin/adb' } }),
  });
  assert.deepEqual(found, { path: '/usr/bin/adb', bundled: false });

  const none = await resolveOne('adb', 'X_ADB', { env: {}, root: path.join('app'), ...world() });
  assert.equal(none, null);
});
