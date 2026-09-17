import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

/**
 * A bug we actually hit under real conditions, not just in theory: a
 * obs-phonecast session would disconnect the stream, with not a single error
 * line on the scrcpy side, after a variable delay (10 to 15s) completely
 * unrelated to the arguments passed to scrcpy or to OBS capture itself
 * (confirmed by elimination: execa alone, with none of the rest of
 * obs-phonecast around it, never disconnected).
 *
 * Real cause: `obs-websocket-js` exposes OBSWebSocket as a standard Node
 * EventEmitter. An 'error' event emitted with NO listener attached is
 * treated by Node as an unhandled exception, which CRASHES THE ENTIRE
 * PROCESS -- not just the OBS connection. The cleanup on
 * `process.on('exit')` then killed scrcpy, believing it was cleaning up
 * after a normal exit.
 *
 * This test can't open a real OBS connection (no hardware here), but it
 * locks in the CONTRACT that avoids this whole class of bug: any object
 * that inherits from EventEmitter and can emit 'error' asynchronously
 * (after the function that creates it has already returned) MUST have an
 * 'error' listener attached before that becomes possible.
 */

test('an EventEmitter with no "error" listener crashes the process (mechanism reminder)', () => {
  // This test doesn't check our code: it documents, in an executable way,
  // the exact Node behavior that caused the bug, so the reason for the
  // rule below stays obvious even if this file is read without the
  // conversation that produced it.
  const emitter = new EventEmitter();
  assert.throws(() => emitter.emit('error', new Error('boom')), /boom/);
});

test('the same EventEmitter with a listener attached does not crash', () => {
  const emitter = new EventEmitter();
  let caught = null;
  emitter.on('error', (err) => {
    caught = err;
  });

  assert.doesNotThrow(() => emitter.emit('error', new Error('boom')));
  assert.equal(caught.message, 'boom');
});

test('connectObs attaches an "error" listener BEFORE any connection attempt', async () => {
  // We can't connect to a real OBS here, but we can verify that the source
  // code attaches the listener before the first `await obs.connect(...)`
  // -- that's the order that matters, since the event can occur as early
  // as the connection attempt itself.
  const src = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../src/obs/client.js', import.meta.url), 'utf8'),
  );

  // Strip comment lines before searching: the comment explaining THIS
  // rule literally mentions "obs.connect(...)" as text, which threw off a
  // naive search over the raw file.
  const code = src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  const errorListenerIndex = code.indexOf("obs.on('error'");
  const firstConnectIndex = code.indexOf('await obs.connect(');

  assert.ok(errorListenerIndex !== -1, 'no "error" listener found on the OBS connection');
  assert.ok(
    errorListenerIndex < firstConnectIndex,
    'the "error" listener must be attached before the first obs.connect()',
  );
});
