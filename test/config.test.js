import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { loadConfig, wrapParseArgsError } from '../src/config.js';
import { isExpectedError, ErrorCode } from '../src/errors.js';

test('an invalid JSON config is a user-facing error that names the file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'phonecast-cfg-'));
  const file = path.join(dir, 'obs-phonecast.json');
  try {
    await writeFile(file, '{ not json');
    await assert.rejects(
      () => loadConfig({}, { file }),
      (err) => {
        assert.equal(isExpectedError(err), true);
        assert.equal(err.code, ErrorCode.CONFIG_UNREADABLE);
        assert.ok(err.hint.includes(file));
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing config file is not an error', async () => {
  const config = await loadConfig({}, { file: path.join(tmpdir(), 'phonecast-does-not-exist.json') });
  assert.equal(config.obs.port, 4455);
});

test('an unknown CLI option becomes an expected ConfigError pointing at --help', () => {
  let caught;
  try {
    parseArgs({ args: ['--nope'], options: {}, allowPositionals: false });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.code, 'ERR_PARSE_ARGS_UNKNOWN_OPTION');

  const wrapped = wrapParseArgsError(caught);
  assert.equal(isExpectedError(wrapped), true);
  assert.match(wrapped.hint, /--help/);
});

test('a missing option value is also wrapped', () => {
  let caught;
  try {
    parseArgs({ args: ['--app'], options: { app: { type: 'string' } } });
  } catch (err) {
    caught = err;
  }
  assert.equal(isExpectedError(wrapParseArgsError(caught)), true);
});

test('errors that are not parseArgs failures stay bugs', () => {
  const bug = new TypeError('boom');
  assert.equal(wrapParseArgsError(bug), bug);
  assert.equal(isExpectedError(wrapParseArgsError(bug)), false);
});
