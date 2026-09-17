import { test } from 'node:test';
import assert from 'node:assert/strict';

import { placeSource, setupScene } from '../src/obs/scene.js';
import { getCaptureDescriptor } from '../src/obs/platform.js';

// The real, current-platform kind: on Linux this is xcomposite_input, on
// Windows/macOS it's window_capture. Hardcoding one would make this test
// fail on whichever OS it doesn't match -- exactly the mismatch ensureInput
// itself is designed to catch for real users.
const REAL_INPUT_KIND = getCaptureDescriptor().inputKind;

/**
 * A fake OBS client: records every call made, and answers just enough to
 * drive the code paths these tests exercise. No real OBS connection
 * needed, same reasoning as the fake orchestrator deps used for
 * bridge.test.js.
 */
function fakeObs({ sourceWidth = 1080, sourceHeight = 2000 } = {}) {
  const calls = [];
  const obs = {
    calls,
    async call(request, params) {
      calls.push({ request, params });
      switch (request) {
        case 'GetSceneItemId':
          return { sceneItemId: 1 };
        case 'GetSceneItemTransform':
          return { sceneItemTransform: { sourceWidth, sourceHeight } };
        case 'GetVideoSettings':
          return { baseWidth: 1920, baseHeight: 1080 };
        case 'SetSceneItemTransform':
          return {};
        default:
          throw new Error(`unexpected call in test fake: ${request}`);
      }
    },
  };
  return obs;
}

/* --- placeSource: the core fix --------------------------------------------- */

test('reposition: true (default) computes and applies a transform', async () => {
  const obs = fakeObs();
  const result = await placeSource(obs, { sceneName: 'Phone', inputName: 'Phone Screen' });

  assert.equal(result.repositioned, true);
  assert.ok(obs.calls.some((c) => c.request === 'SetSceneItemTransform'));
});

test('reposition: false never touches the transform, but still checks for a frame', async () => {
  // This is the actual fix: a source that already existed (and may have
  // been manually framed by a streamer) must not get its position/size
  // silently overwritten on every relaunch.
  const obs = fakeObs();
  const result = await placeSource(obs, {
    sceneName: 'Phone',
    inputName: 'Phone Screen',
    reposition: false,
  });

  assert.equal(result.repositioned, false);
  assert.ok(!obs.calls.some((c) => c.request === 'SetSceneItemTransform'));
  // The frame-arrival check must still run: it's what the caller uses to
  // decide whether to fall back to mirror mode, independent of framing.
  assert.ok(obs.calls.some((c) => c.request === 'GetSceneItemTransform'));
});

test('reposition: false still surfaces a stuck-at-0x0 source as an error', async () => {
  // Skipping the reposition step must not also skip the "did OBS actually
  // get a frame" signal -- that's a separate concern from where the box sits.
  const obs = fakeObs({ sourceWidth: 0, sourceHeight: 0 });
  await assert.rejects(
    () =>
      placeSource(obs, {
        sceneName: 'Phone',
        inputName: 'Phone Screen',
        reposition: false,
        frameTimeoutMs: 50,
      }),
    /0x0/,
  );
});

/* --- setupScene: reposition is derived from created flags ------------------ */

/** A fuller fake, covering the whole setupScene sequence. */
function fakeObsForSetup({ sceneExists, inputExists, inputKind = REAL_INPUT_KIND }) {
  const calls = [];
  const obs = {
    calls,
    async call(request, params) {
      calls.push({ request, params });
      switch (request) {
        case 'GetSceneList':
          return { scenes: sceneExists ? [{ sceneName: 'Phone' }] : [] };
        case 'CreateScene':
          return {};
        case 'GetInputList':
          return {
            inputs: inputExists ? [{ inputName: 'Phone Screen', inputKind }] : [],
          };
        case 'CreateInput':
        case 'SetInputSettings':
          return {};
        case 'GetInputPropertiesListPropertyItems':
          return { propertyItems: [{ itemName: 'OBS-PHONECAST', itemValue: 'OBS-PHONECAST:x:y' }] };
        case 'GetSceneItemId':
          return { sceneItemId: 1 };
        case 'GetSceneItemTransform':
          return { sceneItemTransform: { sourceWidth: 1080, sourceHeight: 2000 } };
        case 'GetVideoSettings':
          return { baseWidth: 1920, baseHeight: 1080 };
        case 'SetSceneItemTransform':
          return {};
        default:
          throw new Error(`unexpected call in test fake: ${request}`);
      }
    },
  };
  return obs;
}

test('a brand-new scene and source get auto-positioned', async () => {
  const obs = fakeObsForSetup({ sceneExists: false, inputExists: false });

  const result = await setupScene(obs, {
    sceneName: 'Phone',
    inputName: 'Phone Screen',
    windowTitle: 'OBS-PHONECAST',
  });

  assert.equal(result.repositioned, true);
  assert.ok(obs.calls.some((c) => c.request === 'SetSceneItemTransform'));
});

test('an already-existing scene and source keep their position untouched', async () => {
  // The exact scenario reported: relaunching (or the watchdog restarting
  // after a crash) must not reset a streamer's deliberately-framed source.
  const obs = fakeObsForSetup({ sceneExists: true, inputExists: true });

  const result = await setupScene(obs, {
    sceneName: 'Phone',
    inputName: 'Phone Screen',
    windowTitle: 'OBS-PHONECAST',
  });

  assert.equal(result.repositioned, false);
  assert.ok(!obs.calls.some((c) => c.request === 'SetSceneItemTransform'));
});

test('an existing scene with a brand-new source still gets positioned once', async () => {
  // Only one of the two needs to be new for repositioning to make sense:
  // a fresh source in an old scene has nothing to preserve either.
  const obs = fakeObsForSetup({ sceneExists: true, inputExists: false });

  const result = await setupScene(obs, {
    sceneName: 'Phone',
    inputName: 'Phone Screen',
    windowTitle: 'OBS-PHONECAST',
  });

  assert.equal(result.repositioned, true);
});