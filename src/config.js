/**
 * Configuration loading.
 * Priority: CLI arguments > user file > defaults.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { defaultConfig, Mode } from './scrcpy/args.js';
import { configDir } from './paths.js';

export const CONFIG_FILENAME = 'obs-phonecast.json';

/** Settings specific to the tool, which never trickle down to scrcpy. */
const appDefaults = {
  obs: {
    host: 'localhost',
    port: 4455,
    password: '',
    sceneName: 'Phone',
    inputName: 'Phone Screen',
    // Switching the scene live without the streamer having asked for it
    // would be jarring: off by default.
    switchToScene: false,
  },
  layout: {
    anchor: 'right',
    widthRatio: 0.28,
    marginPx: 24,
  },
  /** Adjustable once and for all if the mirror-mode crop is off. */
  navBarHeight: null,
  statusBarHeight: 0,
  /** Bar cropping in launcher mode. null = computed from DPI. */
  decorationCrop: null,

  /**
   * Extends the physical screen's sleep timeout during the session, and
   * restores it on exit. Originally added to work around a documented
   * scrcpy issue (#6787) where the virtual display blanks after the
   * physical screen turns off.
   *
   * Off by default: confirmed on real hardware that this premise doesn't
   * hold in general -- a similar-looking disconnect persisted even with
   * the screen timeout already disabled manually on at least one tested
   * device. Still available via --extend-screen-timeout for anyone who
   * wants to try it on a different device, but shouldn't run by default
   * and spam the logs with a permission error on ROMs that reject it
   * (confirmed on ColorOS).
   */
  extendScreenTimeout: false,
  screenTimeoutMs: 30 * 60 * 1000,

  /** Windows override: 0 auto, 1 BitBlt, 2 WGC (default). See platform.js. */
  windowCaptureMethod: null,
  noFallback: false,
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Recursive merge: a partial object in the user's file must not wipe out
 *  the sibling keys of the defaults. */
export function deepMerge(base, over) {
  if (!isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(base?.[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

export function configPath() {
  return path.join(configDir(), CONFIG_FILENAME);
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Config unreadable (${file}): ${err.message}`);
  }
}

/**
 * Settings from the environment.
 *
 * This is the right place for a secret: unlike a CLI argument, it shows up
 * neither in shell history nor in the machine's process list.
 */
function fromEnv() {
  const obs = {};
  if (process.env.OBS_PHONECAST_PASSWORD) obs.password = process.env.OBS_PHONECAST_PASSWORD;
  if (process.env.OBS_PHONECAST_PORT) obs.port = Number(process.env.OBS_PHONECAST_PORT);
  if (process.env.OBS_PHONECAST_HOST) obs.host = process.env.OBS_PHONECAST_HOST;
  return Object.keys(obs).length ? { obs } : {};
}

/** Priority: CLI arguments > environment > file > defaults. */
export async function loadConfig(overrides = {}, { file = null } = {}) {
  const base = { ...defaultConfig, ...appDefaults };
  const fromFile = await readJsonIfExists(file ?? configPath());

  let config = deepMerge(base, fromFile);
  config = deepMerge(config, fromEnv());
  config = deepMerge(config, overrides);
  return config;
}

export { Mode };
export { configDir } from './paths.js';
