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
function fakeObs({ sourceWidth = 1080, sourceHeight = 2000, crop = null } = {}) {
  const calls = [];
  const obs = {
    calls,
    async call(request, params) {
      calls.push({ request, params });
      switch (request) {
        case 'GetSceneItemId':
          return { sceneItemId: 1 };
        case 'GetSceneItemTransform':
          return {
            sceneItemTransform: {
              sourceWidth,
              sourceHeight,
              cropTop: crop?.top ?? 0,
              cropBottom: crop?.bottom ?? 0,
              cropLeft: crop?.left ?? 0,
              cropRight: crop?.right ?? 0,
            },
          };
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

/** In-memory stand-in for createCropMemory(), with the same read/write shape. */
function fakeMemory(initial = null) {
  const store = new Map();
  if (initial) store.set('Phone|Phone Screen', initial);
  return {
    store,
    async read(scene, input) {
      return store.get(`${scene}|${input}`) ?? null;
    },
    async write(scene, input, crop) {
      store.set(`${scene}|${input}`, crop);
    },
  };
}

const ZERO = { top: 0, bottom: 0, left: 0, right: 0 };
const sets = (obs) => obs.calls.filter((c) => c.request === 'SetSceneItemTransform');
const place = (obs, options) =>
  placeSource(obs, { sceneName: 'Phone', inputName: 'Phone Screen', reposition: false, ...options });

/** Only crop keys may appear in a SetSceneItemTransform when not repositioning. */
function assertNoGeometryTouched(obs) {
  for (const c of obs.calls.filter((x) => x.request === 'SetSceneItemTransform')) {
    for (const key of Object.keys(c.params.sceneItemTransform)) {
      assert.match(key, /^crop(Top|Bottom|Left|Right)$/, `unexpected key ${key}`);
    }
  }
}

/* --- placeSource: the core fix --------------------------------------------- */

test('reposition: true (default) computes and applies a transform', async () => {
  const obs = fakeObs();
  const result = await placeSource(obs, { sceneName: 'Phone', inputName: 'Phone Screen' });

  assert.equal(result.repositioned, true);
  assert.ok(obs.calls.some((c) => c.request === 'SetSceneItemTransform'));
});

test('reposition: false never touches position or size, but still checks for a frame', async () => {
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
  assertNoGeometryTouched(obs);
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
  assertNoGeometryTouched(obs);
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
/* --- crop is synced even when the item is not repositioned ------------------ */

test('reposition: false still applies the requested crop, and only the crop', async () => {
  const obs = fakeObs();
  await placeSource(obs, {
    sceneName: 'Phone',
    inputName: 'Phone Screen',
    reposition: false,
    crop: { top: 80, bottom: 120, left: 0, right: 0 },
  });

  const sets = obs.calls.filter((c) => c.request === 'SetSceneItemTransform');
  assert.equal(sets.length, 1);
  assert.deepEqual(sets[0].params.sceneItemTransform, {
    cropTop: 80,
    cropBottom: 120,
    cropLeft: 0,
    cropRight: 0,
  });
});

test('reposition: false clears a crop WE applied earlier when none is wanted now', async () => {
  // Launcher run, then a normal run: the old bar trim would cut off the real
  // top and bottom of the app. It is ours (memory says so), so it goes.
  const applied = { top: 80, bottom: 120, left: 0, right: 0 };
  const obs = fakeObs({ crop: applied });
  const memory = fakeMemory(applied);

  await place(obs, { crop: null, cropMemory: memory });

  assert.deepEqual(sets(obs)[0].params.sceneItemTransform, {
    cropTop: 0,
    cropBottom: 0,
    cropLeft: 0,
    cropRight: 0,
  });
  assert.deepEqual(memory.store.get('Phone|Phone Screen'), ZERO);
});

test('a crop the user set by hand is kept, not overwritten', async () => {
  // We last applied no crop; OBS now shows 50px off the top: the streamer did that.
  const obs = fakeObs({ crop: { top: 50, bottom: 0, left: 0, right: 0 } });
  const memory = fakeMemory(ZERO);

  const result = await place(obs, {
    crop: { top: 80, bottom: 120, left: 0, right: 0 },
    cropMemory: memory,
  });

  assert.equal(sets(obs).length, 0, 'no SetSceneItemTransform at all');
  assert.equal(result.cropKept, true);
  assert.deepEqual(result.crop, { top: 50, bottom: 0, left: 0, right: 0 });
  // The memory still describes what WE applied, so the hand-set crop keeps
  // reading as "not ours" on the next run too.
  assert.deepEqual(memory.store.get('Phone|Phone Screen'), ZERO);
});

test('a hand-set crop is also kept when the wanted crop is none', async () => {
  const obs = fakeObs({ crop: { top: 0, bottom: 40, left: 0, right: 0 } });
  const result = await place(obs, { crop: null, cropMemory: fakeMemory(ZERO) });

  assert.equal(sets(obs).length, 0);
  assert.equal(result.cropKept, true);
});

test('our own crop is updated when the wanted crop changes (e.g. another DPI)', async () => {
  const before = { top: 60, bottom: 132, left: 0, right: 0 };
  const after = { top: 90, bottom: 198, left: 0, right: 0 };
  const obs = fakeObs({ crop: before });
  const memory = fakeMemory(before);

  const result = await place(obs, { crop: after, cropMemory: memory });

  assert.equal(result.cropKept, false);
  assert.equal(sets(obs)[0].params.sceneItemTransform.cropTop, 90);
  assert.equal(sets(obs)[0].params.sceneItemTransform.cropBottom, 198);
  assert.deepEqual(memory.store.get('Phone|Phone Screen'), after);
});

test('no record and no crop at all: the wanted crop is applied (nothing to lose)', async () => {
  const obs = fakeObs();
  const memory = fakeMemory(null);
  const wanted = { top: 60, bottom: 132, left: 0, right: 0 };

  await place(obs, { crop: wanted, cropMemory: memory });

  assert.equal(sets(obs)[0].params.sceneItemTransform.cropTop, 60);
  assert.deepEqual(memory.store.get('Phone|Phone Screen'), wanted);
});

test('no record and an existing crop: kept, since it could be the user\'s', async () => {
  // First run after an upgrade, or the cache was deleted: be conservative.
  const obs = fakeObs({ crop: { top: 60, bottom: 132, left: 0, right: 0 } });
  const memory = fakeMemory(null);

  const result = await place(obs, { crop: null, cropMemory: memory });

  assert.equal(sets(obs).length, 0);
  assert.equal(result.cropKept, true);
  assert.equal(memory.store.size, 0, 'nothing recorded for a crop we did not apply');
});

test('without any memory, a hand-set crop is still never overwritten', async () => {
  const obs = fakeObs({ crop: { top: 10, bottom: 0, left: 0, right: 0 } });
  const result = await place(obs, { crop: { top: 80, bottom: 120, left: 0, right: 0 } });

  assert.equal(sets(obs).length, 0);
  assert.equal(result.cropKept, true);
});

test('forceCrop (an explicit --crop-top) beats a crop set by hand', async () => {
  const obs = fakeObs({ crop: { top: 50, bottom: 0, left: 0, right: 0 } });
  const memory = fakeMemory(ZERO);
  const wanted = { top: 80, bottom: 120, left: 0, right: 0 };

  const result = await place(obs, { crop: wanted, forceCrop: true, cropMemory: memory });

  assert.equal(result.cropKept, false);
  assert.equal(sets(obs)[0].params.sceneItemTransform.cropTop, 80);
  assert.deepEqual(memory.store.get('Phone|Phone Screen'), wanted);
});

test('the crop is already right: no call to OBS, but the memory is brought up to date', async () => {
  const wanted = { top: 60, bottom: 132, left: 0, right: 0 };
  const obs = fakeObs({ crop: wanted });
  const memory = fakeMemory(null);

  const result = await place(obs, { crop: wanted, cropMemory: memory });

  assert.equal(sets(obs).length, 0);
  assert.equal(result.cropKept, false);
  assert.deepEqual(memory.store.get('Phone|Phone Screen'), wanted);
});

test('a freshly positioned source records the crop it was given', async () => {
  const obs = fakeObs();
  const memory = fakeMemory(null);
  const wanted = { top: 60, bottom: 132, left: 0, right: 0 };

  await placeSource(obs, {
    sceneName: 'Phone',
    inputName: 'Phone Screen',
    crop: wanted,
    cropMemory: memory,
  });

  assert.deepEqual(memory.store.get('Phone|Phone Screen'), wanted);
});

test('setupScene on existing scene + source forwards the launcher crop', async () => {
  const obs = fakeObsForSetup({ sceneExists: true, inputExists: true });
  await setupScene(obs, {
    sceneName: 'Phone',
    inputName: 'Phone Screen',
    windowTitle: 'OBS-PHONECAST',
    crop: { top: 10, bottom: 20, left: 0, right: 0 },
  });
  const set = obs.calls.find((c) => c.request === 'SetSceneItemTransform');
  assert.equal(set.params.sceneItemTransform.cropTop, 10);
  assert.equal(set.params.sceneItemTransform.cropBottom, 20);
});
