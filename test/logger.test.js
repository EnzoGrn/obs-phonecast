import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createLogger,
  createBufferSink,
  combineSinks,
  silentLogger,
  LEVELS,
} from '../src/logger.js';

/** Test sink: collects raw records. */
function capture() {
  const records = [];
  const sink = (r) => records.push(r);
  return { sink, records };
}

test('the threshold filters out lower levels', () => {
  const { sink, records } = capture();
  const log = createLogger({ level: 'warn', sink });

  log.error('e');
  log.warn('w');
  log.info('i');
  log.debug('d');

  assert.deepEqual(
    records.map((r) => r.level),
    ['error', 'warn'],
  );
});

test('debug level: everything gets through', () => {
  const { sink, records } = capture();
  const log = createLogger({ level: 'debug', sink });
  log.error('e');
  log.debug('d');
  assert.equal(records.length, 2);
});

test('silent level: nothing gets through, not even errors', () => {
  const { sink, records } = capture();
  const log = createLogger({ level: 'silent', sink });
  log.error('e');
  assert.equal(records.length, 0);
});

test('the sink receives a structured record, not a string', () => {
  // This is what will let the dock color-code by level and filter.
  const { sink, records } = capture();
  createLogger({ level: 'info', sink }).info('hello');

  assert.equal(records[0].level, 'info');
  assert.equal(records[0].message, 'hello');
  assert.equal(typeof records[0].time, 'number');
});

test('setSink redirects output without touching callers', () => {
  // The exact scenario for the future dock: switching stderr -> browser.
  const a = capture();
  const b = capture();
  const log = createLogger({ level: 'info', sink: a.sink });

  log.info('before');
  log.setSink(b.sink);
  log.info('after');

  assert.deepEqual(
    a.records.map((r) => r.message),
    ['before'],
  );
  assert.deepEqual(
    b.records.map((r) => r.message),
    ['after'],
  );
});

test('setLevel changes the threshold on the fly', () => {
  const { sink, records } = capture();
  const log = createLogger({ level: 'error', sink });

  log.info('ignored');
  log.setLevel('debug');
  log.info('visible');

  assert.deepEqual(
    records.map((r) => r.message),
    ['visible'],
  );
});

test('child prefixes and inherits the sink and the level', () => {
  const { sink, records } = capture();
  const log = createLogger({ level: 'info', sink });
  const child = log.child('[adb] ');

  child.info('connected');

  assert.equal(records[0].message, '[adb] connected');
});

test('child prefixes stack up', () => {
  const { sink, records } = capture();
  createLogger({ level: 'info', sink }).child('[a] ').child('[b] ').info('x');
  assert.equal(records[0].message, '[a] [b] x');
});

test('enabled lets you skip an expensive computation', () => {
  const log = createLogger({ level: 'info', sink: () => {} });
  assert.equal(log.enabled('info'), true);
  assert.equal(log.enabled('debug'), false);
});

test('createBufferSink keeps the last N records', () => {
  const buffer = createBufferSink({ max: 3 });
  const log = createLogger({ level: 'debug', sink: buffer });

  for (const n of [1, 2, 3, 4, 5]) log.info(`msg${n}`);

  assert.equal(buffer.records.length, 3);
  assert.deepEqual(
    buffer.records.map((r) => r.message),
    ['msg3', 'msg4', 'msg5'],
  );
  assert.match(buffer.dump(), /\[info\] msg5/);
});

test('a failing sink doesn\'t block the others', () => {
  // Logging must never make the caller fail.
  const { sink, records } = capture();
  const broken = () => {
    throw new Error('broken sink');
  };
  const log = createLogger({ level: 'info', sink: combineSinks(broken, sink) });

  assert.doesNotThrow(() => log.info('still gets through'));
  assert.equal(records[0].message, 'still gets through');
});

test('silentLogger is usable as an inert default', () => {
  assert.doesNotThrow(() => {
    silentLogger.error('nothing');
    silentLogger.debug('nothing');
  });
});

test('levels are ordered from most severe to most verbose', () => {
  assert.ok(LEVELS.silent < LEVELS.error);
  assert.ok(LEVELS.error < LEVELS.warn);
  assert.ok(LEVELS.warn < LEVELS.info);
  assert.ok(LEVELS.info < LEVELS.debug);
});
