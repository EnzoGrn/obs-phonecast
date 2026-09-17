import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PhonecastError,
  ErrorCode,
  isExpectedError,
  formatError,
} from '../src/errors.js';
import { ConfigError, buildArgs, defaultConfig } from '../src/scrcpy/args.js';
import { AppsError, findApp } from '../src/scrcpy/app-list.js';

test('every user-facing error carries code, hint, and expected', () => {
  const err = new PhonecastError('boom', {
    hint: 'do this',
    code: ErrorCode.ADB_UNAUTHORIZED,
  });
  assert.equal(err.code, 'ADB_UNAUTHORIZED');
  assert.equal(err.hint, 'do this');
  assert.equal(err.expected, true);
});

test('the name comes from the subclass, without redeclaring it', () => {
  class MyError extends PhonecastError {}
  assert.equal(new MyError('x').name, 'MyError');
});

test('default code: UNKNOWN', () => {
  assert.equal(new PhonecastError('x').code, ErrorCode.UNKNOWN);
});

test('cause is preserved for diagnostics', () => {
  const root = new Error('ECONNREFUSED');
  const err = new PhonecastError('connection failed', { cause: root });
  assert.equal(err.cause, root);
});

/* --- isExpectedError: this is what tells a bug apart from a user-facing error --- */

test('a user-facing error is expected', () => {
  assert.equal(isExpectedError(new PhonecastError('x')), true);
});

test('a TypeError is not -- it\'s a bug', () => {
  assert.equal(isExpectedError(new TypeError('x is not a function')), false);
  assert.equal(isExpectedError(new Error('generic')), false);
});

test('module subclasses are recognized as expected', () => {
  assert.equal(isExpectedError(new ConfigError('x')), true);
  assert.equal(isExpectedError(new AppsError('x')), true);
});

/* --- formatError -------------------------------------------------------------- */

test('formatError combines message and hint into one block', () => {
  // In a single block because the sink prefixes "Error: ": two separate
  // calls would put that prefix in front of the hint too.
  const err = new PhonecastError('failed', { hint: 'plug in the cable' });
  assert.equal(formatError(err), 'failed\n\nplug in the cable');
});

test('formatError with no hint: message alone, no blank lines', () => {
  assert.equal(formatError(new PhonecastError('failed')), 'failed');
});

test('formatError tolerates a non-obs-phonecast error', () => {
  assert.equal(formatError(new Error('raw')), 'raw');
});

/* --- real codes emitted by the modules ------------------------------------------ */

test('an invalid config carries CONFIG_INVALID', () => {
  try {
    buildArgs({ ...defaultConfig, video: { ...defaultConfig.video, codec: 'vp9' } });
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, ErrorCode.CONFIG_INVALID);
  }
});

test('an app that can\'t be found carries APPS_NOT_FOUND', () => {
  const apps = [{ name: 'YouTube', package: 'com.google.android.youtube', system: false }];
  try {
    findApp(apps, 'zzz');
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, ErrorCode.APPS_NOT_FOUND);
  }
});

test('an ambiguity carries APPS_AMBIGUOUS', () => {
  const apps = [
    { name: 'Chat A', package: 'com.a.chat', system: false },
    { name: 'Chat B', package: 'com.b.chat', system: false },
  ];
  try {
    findApp(apps, 'chat');
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, ErrorCode.APPS_AMBIGUOUS);
  }
});

test('codes are unique', () => {
  const values = Object.values(ErrorCode);
  assert.equal(new Set(values).size, values.length);
});

test('toJSON exposes what the dock needs', () => {
  const json = new PhonecastError('m', { hint: 'h', code: ErrorCode.OBS_AUTH_FAILED }).toJSON();
  assert.deepEqual(json, {
    name: 'PhonecastError',
    code: 'OBS_AUTH_FAILED',
    message: 'm',
    hint: 'h',
  });
});
