import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchWindowItem, getCaptureDescriptor, isWayland } from '../src/obs/platform.js';
import { deepMerge } from '../src/config.js';

/* --- matchWindowItem ------------------------------------------------------- */

test('prefix strategy: exact title', () => {
  const items = [{ itemName: 'OBS-PHONECAST', itemValue: 'OBS-PHONECAST:SDL:scrcpy.exe' }];
  assert.equal(matchWindowItem(items, 'OBS-PHONECAST', 'prefix'), 'OBS-PHONECAST:SDL:scrcpy.exe');
});

test('prefix strategy: title followed by class and exe', () => {
  const items = [
    { itemName: 'Firefox', itemValue: 'Firefox:Mozilla:firefox.exe' },
    { itemName: 'OBS-PHONECAST:SDL_app:scrcpy.exe', itemValue: 'OBS-PHONECAST:SDL_app:scrcpy.exe' },
  ];
  assert.equal(matchWindowItem(items, 'OBS-PHONECAST', 'prefix'), 'OBS-PHONECAST:SDL_app:scrcpy.exe');
});

test('prefix strategy: doesn\'t match a title that contains it without starting with it', () => {
  const items = [{ itemName: 'MY OBS-PHONECAST WINDOW', itemValue: 'x' }];
  // The itemValue fallback doesn't find anything here either.
  assert.equal(matchWindowItem(items, 'OBS-PHONECAST', 'prefix'), null);
});

test('substring strategy: numeric value preserved (macOS CGWindowID)', () => {
  const items = [
    { itemName: 'Safari', itemValue: 101 },
    { itemName: '[scrcpy] OBS-PHONECAST', itemValue: 4242 },
  ];
  const value = matchWindowItem(items, 'OBS-PHONECAST', 'substring');
  assert.equal(value, 4242);
  assert.equal(typeof value, 'number', 'the type must not be converted to a string');
});

test('no match: null', () => {
  assert.equal(matchWindowItem([{ itemName: 'OBS', itemValue: 'OBS' }], 'OBS-PHONECAST', 'prefix'), null);
});

test('missing or empty list: null, no throw', () => {
  assert.equal(matchWindowItem(undefined, 'OBS-PHONECAST', 'prefix'), null);
  assert.equal(matchWindowItem([], 'OBS-PHONECAST', 'prefix'), null);
});

/* --- getCaptureDescriptor --------------------------------------------------- */

test('the descriptor exposes the expected keys on this platform', (t) => {
  if (isWayland()) {
    t.skip('Wayland session: window capture cannot be automated');
    return;
  }
  const d = getCaptureDescriptor();
  assert.equal(typeof d.inputKind, 'string');
  assert.equal(typeof d.windowProperty, 'string');
  assert.ok(['prefix', 'substring'].includes(d.matchStrategy));
  // The property name differs by OS: that's the whole reason this file exists.
  const expected = { win32: 'window', darwin: 'window', linux: 'capture_window' };
  assert.equal(d.windowProperty, expected[process.platform]);
});

test('Windows: the default capture method is forced WGC (2), not Automatic', (t) => {
  // Locks in a real regression: switching to 0 (Automatic) makes OBS
  // sometimes resolve to BitBlt, which fails silently (source stuck at
  // 0x0, no frame) on D3D11-rendered windows like scrcpy's. Observed under
  // real conditions, not just in theory.
  if (process.platform !== 'win32') {
    t.skip('Windows-specific');
    return;
  }
  assert.equal(getCaptureDescriptor().initialSettings.method, 2);
});

test('Windows: the capture method stays adjustable for environments that need it', (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-specific');
    return;
  }
  assert.equal(getCaptureDescriptor({ windowCaptureMethod: 0 }).initialSettings.method, 0);
  assert.equal(getCaptureDescriptor({ windowCaptureMethod: 1 }).initialSettings.method, 1);
});

/* --- deepMerge --------------------------------------------------------------- */

test('deepMerge: a partial object doesn\'t wipe out sibling keys', () => {
  const base = { obs: { host: 'localhost', port: 4455, password: '' } };
  const out = deepMerge(base, { obs: { password: 'secret' } });
  assert.deepEqual(out.obs, { host: 'localhost', port: 4455, password: 'secret' });
});

test('deepMerge: undefined never overwrites', () => {
  const out = deepMerge({ a: 1 }, { a: undefined });
  assert.equal(out.a, 1);
});

test('deepMerge: arrays are replaced, not merged', () => {
  const out = deepMerge({ list: [1, 2, 3] }, { list: [9] });
  assert.deepEqual(out.list, [9]);
});
