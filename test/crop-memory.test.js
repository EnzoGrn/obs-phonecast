import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCropMemory } from '../src/obs/crop-memory.js';
import { placeSource } from '../src/obs/scene.js';

async function tmpFile(name = 'obs-crop.json') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'phonecast-crop-'));
  return { dir, file: path.join(dir, name) };
}

const CROP = { top: 60, bottom: 132, left: 0, right: 0 };

test('nothing recorded yet reads as null', async () => {
  const { dir, file } = await tmpFile();
  try {
    assert.equal(await createCropMemory({ file }).read('Phone', 'Phone Screen'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a written crop is read back, per scene and source', async () => {
  const { dir, file } = await tmpFile();
  try {
    const memory = createCropMemory({ file });
    await memory.write('Phone', 'Phone Screen', CROP);
    await memory.write('Other', 'Phone Screen', { top: 1, bottom: 2, left: 3, right: 4 });

    assert.deepEqual(await memory.read('Phone', 'Phone Screen'), CROP);
    assert.deepEqual(await memory.read('Other', 'Phone Screen'), { top: 1, bottom: 2, left: 3, right: 4 });
    assert.equal(await memory.read('Phone', 'Unknown'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt file reads as "nothing recorded" and is repaired by the next write', async () => {
  const { dir, file } = await tmpFile();
  try {
    await writeFile(file, '{not json', 'utf8');
    const memory = createCropMemory({ file });

    assert.equal(await memory.read('Phone', 'Phone Screen'), null);
    await memory.write('Phone', 'Phone Screen', CROP);
    assert.deepEqual(await memory.read('Phone', 'Phone Screen'), CROP);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('malformed entries are ignored, not trusted', async () => {
  const { dir, file } = await tmpFile();
  try {
    const key = JSON.stringify(['Phone', 'Phone Screen']);
    for (const bad of [null, 'x', 5, [1, 2], { top: 1 }, { top: -1, bottom: 0, left: 0, right: 0 },
      { top: 'a', bottom: 0, left: 0, right: 0 }]) {
      await writeFile(file, JSON.stringify({ [key]: bad }), 'utf8');
      assert.equal(await createCropMemory({ file }).read('Phone', 'Phone Screen'), null);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writing an invalid crop records nothing', async () => {
  const { dir, file } = await tmpFile();
  try {
    const memory = createCropMemory({ file });
    await memory.write('Phone', 'Phone Screen', { top: NaN, bottom: 0, left: 0, right: 0 });
    await memory.write('Phone', 'Phone Screen', null);
    assert.equal(await memory.read('Phone', 'Phone Screen'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a write that cannot succeed never throws', async () => {
  const { dir, file } = await tmpFile();
  try {
    // The "directory" of the target is an existing FILE: mkdir/writeFile fail.
    await writeFile(file, 'x', 'utf8');
    const memory = createCropMemory({ file: path.join(file, 'nested', 'obs-crop.json') });
    await assert.doesNotReject(() => memory.write('Phone', 'Phone Screen', CROP));
    assert.equal(await memory.read('Phone', 'Phone Screen'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the file is plain JSON, easy to delete or inspect by hand', async () => {
  const { dir, file } = await tmpFile();
  try {
    await createCropMemory({ file }).write('Phone', 'Phone Screen', CROP);
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(Object.values(parsed), [CROP]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* --- end to end with the real memory: the cycle that motivated all of this - */

function obsWithCrop(state) {
  const calls = [];
  return {
    calls,
    async call(request, params) {
      calls.push({ request, params });
      switch (request) {
        case 'GetSceneItemId':
          return { sceneItemId: 1 };
        case 'GetSceneItemTransform':
          return {
            sceneItemTransform: {
              sourceWidth: 1080,
              sourceHeight: 2000,
              cropTop: state.top,
              cropBottom: state.bottom,
              cropLeft: state.left,
              cropRight: state.right,
            },
          };
        case 'SetSceneItemTransform': {
          const t = params.sceneItemTransform;
          state.top = t.cropTop ?? state.top;
          state.bottom = t.cropBottom ?? state.bottom;
          state.left = t.cropLeft ?? state.left;
          state.right = t.cropRight ?? state.right;
          return {};
        }
        default:
          throw new Error(`unexpected call: ${request}`);
      }
    },
  };
}

const run = (obs, cropMemory, options) =>
  placeSource(obs, {
    sceneName: 'Phone',
    inputName: 'Phone Screen',
    reposition: false,
    cropMemory,
    ...options,
  });

test('launcher run, plain run, hand crop, launcher run: each step does the right thing', async () => {
  const { dir, file } = await tmpFile();
  try {
    const memory = createCropMemory({ file });
    const state = { top: 0, bottom: 0, left: 0, right: 0 };
    const obs = () => obsWithCrop(state);

    // 1. Launcher run on an existing, uncropped source: the bars get trimmed.
    let result = await run(obs(), memory, { crop: CROP });
    assert.deepEqual(state, CROP);
    assert.equal(result.cropKept, false);

    // 2. Plain run next: our bar trim is cleared, the real app is whole again.
    result = await run(obs(), memory, { crop: null });
    assert.deepEqual(state, { top: 0, bottom: 0, left: 0, right: 0 });
    assert.equal(result.cropKept, false);

    // 3. The streamer crops 30px off the left by hand in OBS.
    state.left = 30;

    // 4. Launcher run again: their crop survives, and we say so.
    result = await run(obs(), memory, { crop: CROP });
    assert.deepEqual(state, { top: 0, bottom: 0, left: 30, right: 0 });
    assert.equal(result.cropKept, true);

    // 5. ...and a plain run keeps it as well.
    result = await run(obs(), memory, { crop: null });
    assert.equal(state.left, 30);
    assert.equal(result.cropKept, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
