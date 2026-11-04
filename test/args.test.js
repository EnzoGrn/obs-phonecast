import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildArgs,
  deriveCrop,
  deriveDecorationCrop,
  defaultConfig,
  validateConfig,
  ConfigError,
  Mode,
  WINDOW_TITLE,
} from '../src/scrcpy/args.js';

/** Shallow merge, good enough for tests. */
const cfg = (over = {}) => ({
  ...defaultConfig,
  ...over,
  display: { ...defaultConfig.display, ...(over.display ?? {}) },
  video: { ...defaultConfig.video, ...(over.video ?? {}) },
  audio: { ...defaultConfig.audio, ...(over.audio ?? {}) },
  control: { ...defaultConfig.control, ...(over.control ?? {}) },
});

test('virtual mode: the three essential options are present', () => {
  const args = buildArgs(cfg({ app: 'com.example.app' }));
  assert.ok(args.includes('--new-display=1080x2000/420'));
  assert.ok(args.includes('--no-vd-system-decorations'));
  assert.ok(args.includes('--start-app=com.example.app'));
});

test('the window title is fixed and not configurable', () => {
  const args = buildArgs(cfg({ app: 'com.example.app' }));
  assert.ok(args.includes(`--window-title=${WINDOW_TITLE}`));
});

test('forceStopApp prefixes the package with +', () => {
  const args = buildArgs(cfg({ app: 'com.example.app', forceStopApp: true }));
  assert.ok(args.includes('--start-app=+com.example.app'));
});

test('virtual mode with no app: explicit refusal', () => {
  assert.throws(() => buildArgs(cfg({ app: null })), ConfigError);
});

test('mirror mode: crop formatted as w:h:x:y, no new-display', () => {
  const args = buildArgs(
    cfg({ mode: Mode.MIRROR, crop: { width: 1080, height: 2200, x: 0, y: 0 } }),
  );
  assert.ok(args.includes('--crop=1080:2200:0:0'));
  assert.ok(!args.some((a) => a.startsWith('--new-display')));
});

test('audio disabled by default via --no-audio', () => {
  const args = buildArgs(cfg({ app: 'com.example.app' }));
  assert.ok(args.includes('--no-audio'));
});

test('audio enabled: no audio flag at all (scrcpy default is fine)', () => {
  const args = buildArgs(cfg({ app: 'com.example.app', audio: { enabled: true } }));
  assert.ok(!args.includes('--no-audio'));
});

test('the serial is passed as -s with its value as a separate arg', () => {
  const args = buildArgs(cfg({ app: 'com.example.app', serial: '192.168.1.42:5555' }));
  assert.equal(args[0], '-s');
  assert.equal(args[1], '192.168.1.42:5555');
});

test('unknown codec: ConfigError', () => {
  assert.throws(
    () => validateConfig(cfg({ app: 'a.b', video: { codec: 'vp9' } })),
    ConfigError,
  );
});

test('malformed bitrate: ConfigError', () => {
  assert.throws(
    () => validateConfig(cfg({ app: 'a.b', video: { bitrate: '16mb' } })),
    ConfigError,
  );
});

test('dpi out of range: ConfigError', () => {
  assert.throws(() => validateConfig(cfg({ app: 'a.b', display: { dpi: 900 } })), ConfigError);
});

test('deriveCrop removes the gesture nav bar', () => {
  const crop = deriveCrop({ deviceWidth: 1080, deviceHeight: 2400, navigationMode: 2 });
  assert.deepEqual(crop, { width: 1080, height: 2352, x: 0, y: 0 });
});

test('deriveCrop removes the three-button bar', () => {
  const crop = deriveCrop({ deviceWidth: 1080, deviceHeight: 2400, navigationMode: 0 });
  assert.equal(crop.height, 2268);
});

test('deriveCrop: an explicit navBarHeight overrides the mode', () => {
  const crop = deriveCrop({
    deviceWidth: 1440,
    deviceHeight: 3200,
    navigationMode: 0,
    navBarHeight: 200,
  });
  assert.equal(crop.height, 3000);
});

test('deriveCrop: statusBarHeight shifts y and reduces height', () => {
  const crop = deriveCrop({
    deviceWidth: 1080,
    deviceHeight: 2400,
    navigationMode: 2,
    statusBarHeight: 100,
  });
  assert.equal(crop.y, 100);
  assert.equal(crop.height, 2252);
});

/* --- launcher mode --------------------------------------------------------- */

test('launcher: decorations are kept', () => {
  const args = buildArgs(cfg({ launcher: true }));
  assert.ok(!args.includes('--no-vd-system-decorations'));
  assert.ok(args.includes('--new-display=1080x2000/420'));
});

test('launcher: app is optional', () => {
  assert.doesNotThrow(() => buildArgs(cfg({ launcher: true, app: null })));
});

test('launcher with no app: no --start-app', () => {
  const args = buildArgs(cfg({ launcher: true, app: null }));
  assert.ok(!args.some((a) => a.startsWith('--start-app')));
});

test('launcher with an app: starts on it, then free navigation', () => {
  const args = buildArgs(cfg({ launcher: true, app: 'com.example.app' }));
  assert.ok(args.includes('--start-app=com.example.app'));
  assert.ok(!args.includes('--no-vd-system-decorations'));
});

test('outside launcher, a missing app is still an error with a hint', () => {
  assert.throws(
    () => buildArgs(cfg({ app: null })),
    (err) => {
      assert.match(err.hint, /--launcher/);
      return true;
    },
  );
});

/* --- deriveDecorationCrop --------------------------------------------------- */

test('dp -> px conversion: 160 dpi is the reference density', () => {
  const crop = deriveDecorationCrop({ dpi: 160 });
  assert.equal(crop.top, 24);
  assert.equal(crop.bottom, 48);
});

test('the crop follows the virtual display\'s DPI', () => {
  // 420 dpi: factor 2.625. The geometry is known since we're the ones
  // setting the DPI when we create the virtual display.
  const crop = deriveDecorationCrop({ dpi: 420 });
  assert.equal(crop.top, 63);
  assert.equal(crop.bottom, 126);
});

test('the dp values are adjustable for out-of-spec manufacturers', () => {
  const crop = deriveDecorationCrop({ dpi: 160, navBarDp: 64 });
  assert.equal(crop.bottom, 64);
});

test('no side cropping', () => {
  const crop = deriveDecorationCrop({ dpi: 420 });
  assert.equal(crop.left, 0);
  assert.equal(crop.right, 0);
});

/* --- control and app launching ---------------------------------------------- */

test('with an app, --no-control is not sent', () => {
  // scrcpy refuses to start an app if control is disabled:
  // "Cannot start an Android app if control is disabled".
  const args = buildArgs(cfg({ app: 'com.example.app' }));
  assert.ok(args.includes('--start-app=com.example.app'));
  assert.ok(!args.includes('--no-control'));
});

test('with no app, --no-control is kept', () => {
  const args = buildArgs(cfg({ launcher: true, app: null }));
  assert.ok(args.includes('--no-control'));
});

test('control explicitly enabled: no --no-control either', () => {
  const args = buildArgs(cfg({ launcher: true, app: null, control: { enabled: true } }));
  assert.ok(!args.includes('--no-control'));
});

test('mirror mode with an app: same rule', () => {
  const args = buildArgs(cfg({ mode: Mode.MIRROR, app: 'com.example.app' }));
  assert.ok(!args.includes('--no-control'));
});

/* --- keep-active: workaround for the virtual display going black ---------- */

test('keep-active is enabled by default', () => {
  const args = buildArgs(cfg({ app: 'com.example.app' }));
  assert.ok(args.includes('--keep-active'));
});

test('keep-active can be explicitly disabled', () => {
  const args = buildArgs(cfg({ app: 'com.example.app', keepActive: false }));
  assert.ok(!args.includes('--keep-active'));
});

/* --- resolveDecorationCrop: partial overrides keep the derived sides -------- */

test('--crop-top alone keeps the DPI-derived bottom crop', async () => {
  const { resolveDecorationCrop, deriveDecorationCrop } = await import('../src/scrcpy/args.js');
  const derived = deriveDecorationCrop({ dpi: 420 });
  const crop = resolveDecorationCrop({ top: 80 }, { dpi: 420 });
  assert.equal(crop.top, 80);
  assert.equal(crop.bottom, derived.bottom);
  assert.ok(crop.bottom > 0);
});

test('a missing decorationCrop resolves entirely from the DPI', async () => {
  const { resolveDecorationCrop, deriveDecorationCrop } = await import('../src/scrcpy/args.js');
  assert.deepEqual(resolveDecorationCrop(null, { dpi: 320 }), deriveDecorationCrop({ dpi: 320 }));
});

test('an explicit 0 is respected (not treated as "missing")', async () => {
  const { resolveDecorationCrop } = await import('../src/scrcpy/args.js');
  assert.equal(resolveDecorationCrop({ bottom: 0 }, { dpi: 420 }).bottom, 0);
});
