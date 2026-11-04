/**
 * Raw read/write access to the config file, as JSON -- not the merged
 * config (CLI args > env > file > defaults) that config.js produces for a
 * running session.
 *
 * Used by the dock's settings panel and by --init. Deliberately separate
 * from config.js's loadConfig(): the dock needs to show and persist
 * exactly what's IN the file, not the fully-resolved config with every
 * default baked in -- writing the merged version back would permanently
 * freeze defaults into the user's file the moment they saved anything.
 */

import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { configPath } from './config.js';
import { ConfigError, BITRATE_RE } from './scrcpy/args.js';

/** Returns {} if the file doesn't exist yet -- a fresh install, most likely. */
export async function readRawConfig(file = null) {
  const target = file ?? configPath();
  try {
    return JSON.parse(await readFile(target, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

/**
 * The single place the config file gets written (--init and the dock both
 * come through here).
 *
 * The file holds the OBS WebSocket password, so it is created 0600 in a
 * 0700 directory (POSIX; on Windows the modes are ignored and the profile
 * ACLs apply). The write is atomic -- a temp file in the SAME directory,
 * then rename -- so a crash or a full disk mid-write can't leave a
 * truncated config behind, and replacing an existing file also replaces its
 * permissions.
 */
export async function writeRawConfig(config, file = null) {
  const target = file ?? configPath();
  // Serialize first: a value JSON can't encode must fail before any file
  // (or directory) is touched.
  const body = `${JSON.stringify(config, null, 2)}\n`;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });

  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return target;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Light shape check for a config object coming from the dock, before it
 * overwrites the file. Not a full schema: unknown keys pass through on
 * purpose (advanced settings the form does not show), only the fields the
 * form edits are checked.
 */
export function validateRawConfig(config) {
  const bad = (message) => new ConfigError(`Invalid config: ${message}`);

  if (!isPlainObject(config)) throw bad('expected a JSON object.');

  const { obs, display, video } = config;
  for (const [name, section] of [
    ['obs', obs],
    ['display', display],
    ['video', video],
  ]) {
    if (section !== undefined && !isPlainObject(section)) {
      throw bad(`"${name}" must be an object.`);
    }
  }

  const port = obs?.port;
  if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) {
    throw bad('"obs.port" must be an integer between 1 and 65535.');
  }

  const dpi = display?.dpi;
  if (dpi !== undefined && !(Number.isInteger(dpi) && dpi > 0)) {
    throw bad('"display.dpi" must be a positive integer.');
  }

  const bitrate = video?.bitrate;
  if (bitrate !== undefined && !BITRATE_RE.test(String(bitrate))) {
    throw bad('"video.bitrate" must look like 8M, 500K or 4000000.');
  }

  return config;
}
