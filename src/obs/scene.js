/**
 * Creating and configuring the OBS scene.
 *
 * The call order isn't intuitive, because of a chicken-and-egg problem:
 * the list of capturable windows can only be queried through a source that
 * ALREADY EXISTS. So we deliberately create an empty source first, then
 * fill it in.
 *
 * Full sequence:
 *   1. GetSceneList                          does the scene exist?
 *   2. CreateScene                           if needed
 *   3. GetInputList                          does the source exist?
 *   4. CreateInput  (settings WITHOUT a window) <- source non-functional here
 *   5. GetInputPropertiesListPropertyItems   we finally get the list
 *   6. SetInputSettings                      bind the window we found
 *   7. SetSceneItemTransform                 placement
 */

import { getCaptureDescriptor, getV4l2Descriptor, matchWindowItem } from './platform.js';
import { PhonecastError, ErrorCode } from '../errors.js';

export class SceneError extends PhonecastError {
  constructor(message, { hint = null, code = ErrorCode.OBS_SCENE_FAILED, cause = null } = {}) {
    super(message, { hint, code, cause });
  }
}

/** Signals that the window never appeared. Triggers the fallback to mirror mode. */
export class WindowNotFoundError extends SceneError {
  constructor(title, timeoutMs) {
    super(`Window "${title}" not found on the OBS side after ${timeoutMs} ms`, {
      code: ErrorCode.OBS_WINDOW_NOT_FOUND,
      hint: 'The phone\'s ROM may be blocking the virtual display. Falling back.',
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------------- */
/* Steps 1-2: the scene                                                      */
/* -------------------------------------------------------------------------- */

export async function ensureScene(obs, sceneName) {
  const { scenes } = await obs.call('GetSceneList');
  if (scenes.some((s) => s.sceneName === sceneName)) {
    return { created: false };
  }
  await obs.call('CreateScene', { sceneName });
  return { created: true };
}

/* -------------------------------------------------------------------------- */
/* Steps 3-4: the source                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Creates the source if missing, with initial settings WITHOUT a window.
 *
 * If the source already exists but with a different inputKind (the user
 * switched OS, or hand-edited their scene), we fail explicitly rather than
 * produce a confusing behavior.
 */
export async function ensureInput(obs, { sceneName, inputName, descriptor }) {
  const { inputs } = await obs.call('GetInputList');
  const existing = inputs.find((i) => i.inputName === inputName);

  if (existing) {
    if (existing.inputKind !== descriptor.inputKind) {
      throw new SceneError(
        `Source "${inputName}" already exists with type "${existing.inputKind}" ` +
          `while this platform expects "${descriptor.inputKind}". `,
        {
          code: ErrorCode.OBS_SOURCE_TYPE_MISMATCH,
          hint: `Delete the source "${inputName}" in OBS and relaunch.`,
        },
      );
    }
    // Reapply the initial settings: they may have been changed by hand.
    await obs.call('SetInputSettings', {
      inputName,
      inputSettings: descriptor.initialSettings,
      overlay: true,
    });
    return { created: false };
  }

  await obs.call('CreateInput', {
    sceneName,
    inputName,
    inputKind: descriptor.inputKind,
    inputSettings: descriptor.initialSettings,
    sceneItemEnabled: true,
  });
  return { created: true };
}

/* -------------------------------------------------------------------------- */
/* Step 5: finding the window                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A single poll. Returns the raw value or null.
 *
 * We query OBS, not the system: that's exactly the condition we care about
 * ("can OBS see this window?"), and it doesn't depend on any scrcpy log
 * string -- so nothing breaks on the next version.
 */
export async function probeWindow(obs, { inputName, descriptor, title }) {
  const { propertyItems } = await obs.call('GetInputPropertiesListPropertyItems', {
    inputName,
    propertyName: descriptor.windowProperty,
  });
  return matchWindowItem(propertyItems, title, descriptor.matchStrategy);
}

/**
 * Repeated polling until the window appears.
 *
 * `isProcessAlive` lets us bail out immediately if scrcpy has died: no
 * point waiting 15 seconds when the process exited after 400ms.
 */
export async function waitForWindow(
  obs,
  { inputName, descriptor, title, timeoutMs = 15_000, intervalMs = 300, isProcessAlive = null },
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (isProcessAlive && !isProcessAlive()) {
      throw new SceneError('scrcpy exited before its window appeared', {
        code: ErrorCode.OBS_WINDOW_NOT_FOUND,
      });
    }
    try {
      const value = await probeWindow(obs, { inputName, descriptor, title });
      if (value != null) return value;
    } catch (err) {
      // The list can be transiently unavailable right after CreateInput.
      // Ignore and retry; only the timeout should cause a failure.
      void err;
    }
    await sleep(intervalMs);
  }

  throw new WindowNotFoundError(title, timeoutMs);
}

/* -------------------------------------------------------------------------- */
/* Step 6: binding the window                                                 */
/* -------------------------------------------------------------------------- */

export async function bindWindow(obs, { inputName, descriptor, windowValue }) {
  await obs.call('SetInputSettings', {
    inputName,
    inputSettings: { [descriptor.windowProperty]: windowValue },
    overlay: true, // merges, doesn't overwrite the initial settings
  });
}

/* -------------------------------------------------------------------------- */
/* Step 7: placement                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Waits for a first frame to arrive.
 *
 * Real gotcha: right after bindWindow, `sourceWidth` and `sourceHeight` are
 * still 0. The window EXISTS (OBS lists it) well before it has produced its
 * first frame: in mirror mode, scrcpy still has to push its server onto the
 * phone and negotiate the stream, which takes several seconds. Any
 * transform computed at that point ends up squashing the source into a
 * corner. We need to wait for non-zero dimensions.
 */
async function waitForSourceSize(obs, { sceneName, sceneItemId, timeoutMs = 15_000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { sceneItemTransform: t } = await obs.call('GetSceneItemTransform', {
      sceneName,
      sceneItemId,
    });
    if (t.sourceWidth > 0 && t.sourceHeight > 0) return t;
    await sleep(150);
  }
  throw new SceneError('Source is stuck at 0x0: no frame received.', {
    code: ErrorCode.OBS_NO_FRAME,
    hint: 'The window may be minimized, or the capture method is incompatible.',
  });
}

/** The four crop fields of a scene item transform; 0 when no crop is wanted. */
function cropTransform(crop) {
  return {
    cropTop: crop?.top ?? 0,
    cropBottom: crop?.bottom ?? 0,
    cropLeft: crop?.left ?? 0,
    cropRight: crop?.right ?? 0,
  };
}

/** A crop as {top, bottom, left, right}, from our shape or an OBS transform. */
function normalizeCrop(crop) {
  return {
    top: crop?.top ?? 0,
    bottom: crop?.bottom ?? 0,
    left: crop?.left ?? 0,
    right: crop?.right ?? 0,
  };
}

function cropFromTransform(t) {
  return normalizeCrop({
    top: t?.cropTop,
    bottom: t?.cropBottom,
    left: t?.cropLeft,
    right: t?.cropRight,
  });
}

const sameCrop = (a, b) =>
  a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right;

const isZeroCrop = (c) => sameCrop(c, { top: 0, bottom: 0, left: 0, right: 0 });

/**
 * On a scene item that already existed, decides whether the crop is ours to
 * change. The streamer may have cropped it by hand in OBS, and that must
 * survive a relaunch the same way a hand-set position does.
 *
 *   - already what we want            -> nothing to do
 *   - same as what WE applied last    -> untouched since: ours, update it
 *     time (from the memory file)
 *   - no record, and no crop at all   -> nothing to lose, apply it
 *   - anything else                   -> the user's own crop: keep it
 *
 * `force` (an explicit --crop-top/--crop-bottom, or "decorationCrop" in the
 * config file) skips the question: a crop asked for by name is applied.
 *
 * @returns {Promise<'apply'|'unchanged'|'keep'>}
 */
async function decideCrop({ current, wanted, force, cropMemory, sceneName, inputName }) {
  if (sameCrop(current, wanted)) return 'unchanged';
  if (force) return 'apply';

  const last = cropMemory ? await cropMemory.read(sceneName, inputName) : null;
  if (last ? sameCrop(current, last) : isZeroCrop(current)) return 'apply';
  return 'keep';
}

/**
 * Places the source via BOUNDS rather than by computing a scale.
 *
 * OBS_BOUNDS_SCALE_INNER fits the source inside the box while preserving
 * the aspect ratio. This avoids any aspect-ratio math, and placement stays
 * correct if the user changes phone resolution.
 */
export async function placeSource(
  obs,
  {
    sceneName,
    inputName,
    anchor = 'right',
    widthRatio = 0.28,
    marginPx = 24,
    /**
     * Crop in SOURCE pixels, applied before scaling by the bounds. This is
     * what makes launcher-mode bars disappear without distorting the
     * image: OBS trims the pixels, then fits the rest into the box.
     */
    crop = null,
    /**
     * true: an explicitly requested crop (--crop-top/--crop-bottom, or
     * "decorationCrop" in the config) is applied even over a crop the user
     * set by hand. Without it, a hand-set crop on an existing item is kept.
     */
    forceCrop = false,
    /**
     * Remembers the crop we last applied, to tell "ours, untouched" from
     * "set by hand". See crop-memory.js. null: no memory (tests, callers
     * that don't care); the conservative fallback in decideCrop applies.
     */
    cropMemory = null,
    frameTimeoutMs = 15_000,
    /**
     * false: leave the scene item's transform exactly as it is. This is
     * what makes a manually-adjusted position survive a relaunch or an
     * automatic watchdog restart -- setupScene passes false whenever the
     * scene and source both already existed (see its `reposition`
     * argument), which means someone already framed this source at some
     * point, deliberately or by accident, and it isn't ours to move again.
     */
    reposition = true,
  },
) {
  const { sceneItemId } = await obs.call('GetSceneItemId', {
    sceneName,
    sourceName: inputName,
  });

  // Kept even when we won't reposition: this is also what tells the caller
  // whether OBS actually received a frame at all, which drives the
  // virtual-display-vs-mirror fallback decision upstream.
  const transform = await waitForSourceSize(obs, {
    sceneName,
    sceneItemId,
    timeoutMs: frameTimeoutMs,
  });

  if (!reposition) {
    // Position and size stay the user's. The crop follows the requested
    // mode (launcher or not) -- unless the user cropped by hand, in which
    // case that is theirs too. A partial transform only touches the four
    // crop fields; OBS leaves the rest of the item's transform alone.
    const wanted = normalizeCrop(crop);
    const decision = await decideCrop({
      current: cropFromTransform(transform),
      wanted,
      force: forceCrop,
      cropMemory,
      sceneName,
      inputName,
    });

    if (decision === 'keep') {
      // Not recorded: the memory keeps describing what WE applied, so the
      // hand-set crop keeps reading as "not ours" on every later run.
      return { sceneItemId, crop: cropFromTransform(transform), repositioned: false, cropKept: true };
    }

    if (decision === 'apply') {
      await obs.call('SetSceneItemTransform', {
        sceneName,
        sceneItemId,
        sceneItemTransform: cropTransform(crop),
      });
    }
    await cropMemory?.write(sceneName, inputName, wanted);
    return { sceneItemId, crop, repositioned: false, cropKept: false };
  }

  const { baseWidth, baseHeight } = await obs.call('GetVideoSettings');

  const boxWidth = Math.round(baseWidth * widthRatio);
  const boxHeight = baseHeight - marginPx * 2;

  let positionX;
  if (anchor === 'left') positionX = marginPx;
  else if (anchor === 'center') positionX = Math.round((baseWidth - boxWidth) / 2);
  else positionX = baseWidth - boxWidth - marginPx;

  await obs.call('SetSceneItemTransform', {
    sceneName,
    sceneItemId,
    sceneItemTransform: {
      boundsType: 'OBS_BOUNDS_SCALE_INNER',
      boundsWidth: boxWidth,
      boundsHeight: boxHeight,
      boundsAlignment: 0, // OBS_ALIGN_CENTER
      alignment: 5, // OBS_ALIGN_LEFT | OBS_ALIGN_TOP
      positionX,
      positionY: marginPx,
      ...cropTransform(crop),
      rotation: 0,
    },
  });

  await cropMemory?.write(sceneName, inputName, normalizeCrop(crop));

  return { sceneItemId, boxWidth, boxHeight, positionX, crop, repositioned: true };
}

/* -------------------------------------------------------------------------- */
/* Scene orchestration                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Runs through the 7 steps.
 *
 * Call this AFTER launching scrcpy: waiting for the window is built in.
 * Lets WindowNotFoundError propagate up, that's the fallback signal the
 * orchestrator waits for.
 */
export async function setupScene(
  obs,
  {
    sceneName = 'Phone',
    inputName = 'Phone Screen',
    windowTitle,
    v4l2Device = null,
    switchToScene = false,
    layout = {},
    crop = null,
    /** See placeSource: an explicitly requested crop beats a hand-set one. */
    forceCrop = false,
    /** See placeSource and crop-memory.js. */
    cropMemory = null,
    /**
     * true: no frame arriving is a failure and triggers the fallback.
     * false: warn and leave the source in place -- on the LAST attempt, a
     * badly positioned source beats no source at all.
     */
    strictFrame = true,
    isProcessAlive = null,
    timeoutMs = 15_000,
    /** Override for the Windows capture method. See platform.js. */
    windowCaptureMethod = null,
    logger = null,
  },
) {
  const descriptor = v4l2Device
    ? getV4l2Descriptor(v4l2Device)
    : getCaptureDescriptor({ windowCaptureMethod });

  const { created: sceneCreated } = await ensureScene(obs, sceneName);
  const { created: inputCreated } = await ensureInput(obs, { sceneName, inputName, descriptor });

  // A real bug we hit: on the very first launch (scene AND source both
  // missing), OBS takes noticeably longer to make the window visible in
  // GetInputPropertiesListPropertyItems than it does on subsequent
  // launches, where both already exist. A timeout tuned for the "already
  // exists" case was triggering a fallback to mirror mode when virtual
  // mode would have worked a few seconds later. So we extend this first
  // poll specifically when creation just happened.
  const firstRunBonusMs = sceneCreated || inputCreated ? 10_000 : 0;
  if (firstRunBonusMs > 0) {
    logger?.debug?.(
      `First-time OBS scene/source creation: extending wait time by ${firstRunBonusMs} ms.`,
    );
  }

  // The webcam output has no window to look for: skip steps 5-6.
  if (!v4l2Device) {
    const windowValue = await waitForWindow(obs, {
      inputName,
      descriptor,
      title: windowTitle,
      timeoutMs: timeoutMs + firstRunBonusMs,
      isProcessAlive,
    });
    await bindWindow(obs, { inputName, descriptor, windowValue });
  }

  let placement = { sceneItemId: null, noFrame: true };
  try {
    placement = await placeSource(obs, {
      sceneName,
      inputName,
      crop,
      forceCrop,
      cropMemory,
      frameTimeoutMs: 15_000 + firstRunBonusMs,
      // Only auto-frame the source the first time it's created. If the
      // scene and the source both already existed, someone (a streamer,
      // most likely) already positioned and sized it -- possibly on a
      // previous day's stream that never had its source deleted -- and an
      // automatic restart or a fresh CLI/dock launch shouldn't silently
      // reset that framing back to the default box every time.
      reposition: sceneCreated || inputCreated,
      ...layout,
    });
  } catch (err) {
    if (strictFrame || err.code !== ErrorCode.OBS_NO_FRAME) throw err;
    // Source created and bound, but no frame yet: leave it as is, OBS will
    // display it as soon as one arrives. Only the automatic placement is lost.
  }

  // Deliberately optional and off by default: switching the scene live
  // without the streamer having asked for it would be jarring.
  if (switchToScene) {
    await obs.call('SetCurrentProgramScene', { sceneName });
  }

  return { sceneName, inputName, inputKind: descriptor.inputKind, ...placement };
}

/** Removes the source. Useful at the end of a session if the user wants it. */
export async function teardownScene(obs, { inputName }) {
  try {
    await obs.call('RemoveInput', { inputName });
  } catch (err) {
    void err; // already gone, nothing to do
  }
}