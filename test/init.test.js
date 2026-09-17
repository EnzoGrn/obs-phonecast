import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildInitConfig, fileExists, runInit } from '../src/init.js';
import { createLogger } from '../src/logger.js';

/** Fake prompt: returns canned answers in order, records what was asked. */
function fakePrompt(answers) {
  const queue = [...answers];
  const asked = [];
  const fn = async (question, opts) => {
    asked.push({ question, opts });
    return queue.shift() ?? '';
  };
  fn.asked = asked;
  return fn;
}

function silentLoggerWithCapture() {
  const records = [];
  const logger = createLogger({ level: 'info', sink: (r) => records.push(r) });
  return { logger, records };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'obs-phonecast-init-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* --- buildInitConfig: pure ---------------------------------------------- */

test('buildInitConfig always sets obs.password, even empty', () => {
  const config = buildInitConfig({ password: '', app: '' });
  assert.deepEqual(config, { obs: { password: '' } });
});

test('buildInitConfig trims the password', () => {
  const config = buildInitConfig({ password: '  secret  ', app: '' });
  assert.equal(config.obs.password, 'secret');
});

test('buildInitConfig omits "app" when blank', () => {
  const config = buildInitConfig({ password: 'x', app: '   ' });
  assert.ok(!('app' in config));
});

test('buildInitConfig includes a trimmed "app" when provided', () => {
  const config = buildInitConfig({ password: 'x', app: '  youtube  ' });
  assert.equal(config.app, 'youtube');
});

/* --- fileExists ------------------------------------------------------------ */

test('fileExists is false for a path that doesn\'t exist', async () => {
  await withTempDir(async (dir) => {
    assert.equal(await fileExists(path.join(dir, 'nope.json')), false);
  });
});

test('fileExists is true once the file is written', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, 'obs-phonecast.json');
    await writeFile(target, '{}');
    assert.equal(await fileExists(target), true);
  });
});

/* --- runInit ---------------------------------------------------------------- */

test('runInit writes a valid config file from the answers given', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, 'nested', 'obs-phonecast.json');
    const { logger } = silentLoggerWithCapture();
    const prompt = fakePrompt(['my-password', 'youtube']);

    const result = await runInit({ logger, file: target, prompt });

    assert.equal(result.created, true);
    assert.equal(result.path, target);

    const written = JSON.parse(await readFile(target, 'utf8'));
    assert.deepEqual(written, { obs: { password: 'my-password' }, app: 'youtube' });
  });
});

test('runInit creates parent directories as needed', async () => {
  // The config dir doesn't exist yet on a fresh install: this is the whole
  // point of --init, so it must not assume the directory is already there.
  await withTempDir(async (dir) => {
    const target = path.join(dir, 'a', 'b', 'c', 'obs-phonecast.json');
    const { logger } = silentLoggerWithCapture();
    await runInit({ logger, file: target, prompt: fakePrompt(['', '']) });
    assert.equal(await fileExists(target), true);
  });
});

test('runInit asks for the password with masking enabled', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, 'obs-phonecast.json');
    const { logger } = silentLoggerWithCapture();
    const prompt = fakePrompt(['x', 'y']);

    await runInit({ logger, file: target, prompt });

    assert.equal(prompt.asked[0].opts?.mask, true);
  });
});

test('runInit refuses to overwrite an existing file without --force', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, 'obs-phonecast.json');
    await writeFile(target, '{"app":"original"}\n');
    const { logger, records } = silentLoggerWithCapture();
    const prompt = fakePrompt(['ignored', 'ignored']);

    const result = await runInit({ logger, file: target, prompt });

    assert.equal(result.created, false);
    assert.equal(prompt.asked.length, 0); // never even prompted
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { app: 'original' });
    assert.ok(records.some((r) => r.message.includes('already exists')));
  });
});

test('runInit overwrites when force is true', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, 'obs-phonecast.json');
    await writeFile(target, '{"app":"original"}\n');
    const { logger } = silentLoggerWithCapture();
    const prompt = fakePrompt(['new-password', '']);

    const result = await runInit({ logger, file: target, force: true, prompt });

    assert.equal(result.created, true);
    const written = JSON.parse(await readFile(target, 'utf8'));
    assert.equal(written.obs.password, 'new-password');
    assert.ok(!('app' in written));
  });
});
