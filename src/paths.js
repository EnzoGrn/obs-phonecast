/**
 * On-disk locations, following each OS's conventions.
 *
 * Extracted from config.js so scrcpy/apps.js can use it without depending
 * on the configuration layer.
 */

import path from 'node:path';
import os from 'node:os';

const APP_NAME = 'obs-phonecast';

export function configDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, APP_NAME);
  }
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, APP_NAME);
  }
  return path.join(os.homedir(), '.config', APP_NAME);
}

/**
 * The cache is separate from the config: it's disposable, and the user
 * should be able to delete it without losing their settings.
 */
export function cacheDir() {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, APP_NAME, 'cache');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', APP_NAME);
  }
  if (process.env.XDG_CACHE_HOME) {
    return path.join(process.env.XDG_CACHE_HOME, APP_NAME);
  }
  return path.join(os.homedir(), '.cache', APP_NAME);
}

/**
 * A wireless serial looks like "192.168.1.42:5555": colons are forbidden
 * in a filename on Windows.
 */
export function safeFilename(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}
