import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readRawConfig, writeRawConfig } from '../src/settings.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'obs-phonecast-settings-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('readRawConfig returns {} when the file doesn\'t exist yet', async () => {
  await withTempDir(async (dir) => {
    const config = await readRawConfig(path.join(dir, 'nope.json'));
    assert.deepEqual(config, {});
  });
});

test('readRawConfig returns exactly what\'s in the file, no defaults merged in', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, 'obs-phonecast.json');
    await writeFile(target, JSON.stringify({ app: 'youtube' }));
    const config = await readRawConfig(target);
    assert.deepEqual(config, { app: 'youtube' });
  });
});

test('writeRawConfig creates parent directories as needed', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, 'a', 'b', 'obs-phonecast.json');
    await writeRawConfig({ app: 'x' }, target);
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { app: 'x' });
  });
});

test('a read/write round trip preserves fields the caller never touched', async () => {
  // This is the property the dock's settings panel depends on: it only
  // edits a handful of known fields, so anything else in the file (set by
  // hand, or by --init) must survive untouched.
  await withTempDir(async (dir) => {
    const target = path.join(dir, 'obs-phonecast.json');
    await writeRawConfig(
      { app: 'youtube', decorationCrop: { top: 63, bottom: 126, left: 0, right: 0 } },
      target,
    );

    const loaded = await readRawConfig(target);
    loaded.obs = { password: 'secret' }; // simulate the dock editing one field
    await writeRawConfig(loaded, target);

    const final = await readRawConfig(target);
    assert.equal(final.app, 'youtube');
    assert.deepEqual(final.decorationCrop, { top: 63, bottom: 126, left: 0, right: 0 });
    assert.equal(final.obs.password, 'secret');
  });
});

/* --- permissions, atomicity, validation -------------------------------------- */

import { stat, readdir } from 'node:fs/promises';
import { validateRawConfig } from '../src/settings.js';

const posix = process.platform !== 'win32';

test('the config file is created 0600 (it holds the OBS password)', { skip: !posix }, async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, 'sub', 'obs-phonecast.json');
    await writeRawConfig({ obs: { password: 'secret' } }, target);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(target))).mode & 0o777, 0o700);
  });
});

test('overwriting a world-readable config tightens it to 0600', { skip: !posix }, async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, 'obs-phonecast.json');
    await writeFile(target, '{}', { mode: 0o644 });
    await writeRawConfig({ a: 1 }, target);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
  });
});

test('the write is atomic: no temp file is left behind, content is complete', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, 'obs-phonecast.json');
    await writeRawConfig({ a: 1 }, target);
    await writeRawConfig({ a: 2 }, target);
    assert.deepEqual(await readdir(dir), ['obs-phonecast.json']);
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { a: 2 });
  });
});

test('a failed write leaves the previous file intact and no temp file', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, 'obs-phonecast.json');
    await writeRawConfig({ keep: true }, target);
    // A circular structure makes JSON.stringify throw before anything is written.
    const circular = {};
    circular.self = circular;
    await assert.rejects(() => writeRawConfig(circular, target));
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { keep: true });
    assert.deepEqual(await readdir(dir), ['obs-phonecast.json']);
  });
});

test('validateRawConfig accepts a plain, partial, or unknown-keyed config', () => {
  assert.doesNotThrow(() => validateRawConfig({}));
  assert.doesNotThrow(() =>
    validateRawConfig({
      obs: { port: 4455 },
      display: { dpi: 420 },
      video: { bitrate: '8M' },
      extra: 1,
    }),
  );
});

test('validateRawConfig rejects bad shapes and values', () => {
  for (const bad of [
    null,
    [],
    'x',
    { obs: [] },
    { obs: { port: '4455' } },
    { obs: { port: 0 } },
    { obs: { port: 70000 } },
    { obs: { port: 4455.5 } },
    { display: { dpi: 'high' } },
    { display: { dpi: -1 } },
    { video: { bitrate: 'fast' } },
    { video: { bitrate: '8MB' } },
  ]) {
    assert.throws(() => validateRawConfig(bad), /Invalid config/, JSON.stringify(bad));
  }
});
