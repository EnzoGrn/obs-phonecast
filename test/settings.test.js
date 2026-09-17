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
