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

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { configPath } from './config.js';

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

export async function writeRawConfig(config, file = null) {
  const target = file ?? configPath();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return target;
}
