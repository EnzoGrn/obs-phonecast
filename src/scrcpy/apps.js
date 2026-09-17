/**
 * Fetching the app list: calling scrcpy and disk caching.
 *
 * Why go through `scrcpy --list-apps` instead of `adb shell pm list
 * packages`: pm only returns package names (`com.zhiliaoapp.musically`),
 * meaningless to a user. scrcpy returns readable labels, but has to query
 * the PackageManager app by app -- hence a several-second wait.
 *
 * Hence the disk cache: without it, every launch of the tool drags.
 *
 * This file contains ONLY side effects. Parsing and name resolution live
 * in app-list.js, with no external dependency, so they stay testable
 * without npm install.
 */

import { execa } from 'execa';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import { cacheDir, safeFilename } from '../paths.js';
import { parseAppList, AppsError } from './app-list.js';
import { ErrorCode } from '../errors.js';

// Facade: consumers import everything from apps.js and stay unaware of
// the internal pure / impure split.
export {
  parseAppList,
  findApp,
  looksLikePackage,
  formatAppList,
  AppsError,
} from './app-list.js';

/** One week. Apps are rarely installed between two streams. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Cache format version: bumping it invalidates old files. */
const CACHE_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Cache                                                                      */
/* -------------------------------------------------------------------------- */

function cacheFile(serial) {
  return path.join(cacheDir(), `apps-${safeFilename(serial)}.json`);
}

async function readCache(serial) {
  try {
    const parsed = JSON.parse(await readFile(cacheFile(serial), 'utf8'));
    if (parsed.version !== CACHE_VERSION) return null;
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    if (!Array.isArray(parsed.apps) || parsed.apps.length === 0) return null;
    return parsed;
  } catch {
    // Missing, unreadable, or corrupt: just reload.
    return null;
  }
}

async function writeCache(serial, apps) {
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(
      cacheFile(serial),
      JSON.stringify({ version: CACHE_VERSION, fetchedAt: Date.now(), serial, apps }),
      'utf8',
    );
  } catch {
    // A cache write failure degrades performance, not functionality.
    // Never a reason to fail the call.
  }
}

export async function clearAppCache(serial) {
  try {
    await unlink(cacheFile(serial));
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Fetching                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * @returns {Promise<{apps: Array, fromCache: boolean, fetchedAt: number}>}
 */
export async function listApps(binaries, serial, { refresh = false, timeoutMs = 30_000 } = {}) {
  if (!refresh) {
    const cached = await readCache(serial);
    if (cached) return { apps: cached.apps, fromCache: true, fetchedAt: cached.fetchedAt };
  }

  // --list-apps exits on its own and opens no window: no need to go
  // through ScrcpyProcess and its clean-shutdown machinery.
  const { stdout, stderr, exitCode } = await execa(
    binaries.scrcpy,
    ['-s', serial, '--list-apps'],
    { reject: false, timeout: timeoutMs, env: { ...process.env, ...binaries.env } },
  );

  // scrcpy writes to stderr, including its informational output.
  const apps = parseAppList(`${stdout}\n${stderr}`);

  if (apps.length === 0) {
    throw new AppsError('No application listed.', {
      code: ErrorCode.APPS_EMPTY,
      hint:
        exitCode === 0
          ? 'Unexpected scrcpy output. Run "scrcpy --list-apps" by hand to see it.'
          : `scrcpy failed (code ${exitCode}): ${stderr.split(/\r?\n/).slice(-3).join(' ')}`,
    });
  }

  await writeCache(serial, apps);
  return { apps, fromCache: false, fetchedAt: Date.now() };
}
