/**
 * Remembers the crop obs-phonecast itself last applied to a scene item.
 *
 * Why this exists: OBS has no way to tag a scene item as "ours", so on a
 * relaunch the tool cannot tell a crop it set earlier (a launcher-mode bar
 * trim it should now update or clear) from a crop the streamer set by hand
 * in OBS (which it must leave alone). Comparing what OBS has today with
 * what we applied last time answers that: equal means untouched since we
 * set it, different means the user changed it.
 *
 * Lives in the cache directory: losing the file is harmless. With no record
 * the caller falls back to a conservative rule (see scene.js, decideCrop).
 * Every failure here is swallowed, like the apps cache: remembering is a
 * convenience, never a reason to fail a session.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { cacheDir } from '../paths.js';

export const CROP_MEMORY_FILENAME = 'obs-crop.json';

const SIDES = ['top', 'bottom', 'left', 'right'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** A crop is exactly four finite, non-negative numbers; anything else is noise. */
function sanitize(value) {
  if (!isPlainObject(value)) return null;
  const out = {};
  for (const side of SIDES) {
    const n = value[side];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
    out[side] = n;
  }
  return out;
}

const keyOf = (sceneName, inputName) => JSON.stringify([sceneName, inputName]);

/**
 * @param {object} [options]
 * @param {string|null} [options.file]  override the storage path (tests)
 */
export function createCropMemory({ file = null } = {}) {
  const target = () => file ?? path.join(cacheDir(), CROP_MEMORY_FILENAME);

  async function load() {
    try {
      const data = JSON.parse(await readFile(target(), 'utf8'));
      return isPlainObject(data) ? data : {};
    } catch {
      return {};
    }
  }

  return {
    /** The crop last applied to this scene item, or null when unknown. */
    async read(sceneName, inputName) {
      const data = await load();
      return sanitize(data[keyOf(sceneName, inputName)]);
    },

    /** Records the crop just applied. Never throws. */
    async write(sceneName, inputName, crop) {
      const clean = sanitize(crop);
      if (!clean) return;
      try {
        const data = await load();
        data[keyOf(sceneName, inputName)] = clean;
        await mkdir(path.dirname(target()), { recursive: true });
        await writeFile(target(), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      } catch {
        /* a lost memory degrades to the conservative fallback, nothing more */
      }
    },
  };
}
