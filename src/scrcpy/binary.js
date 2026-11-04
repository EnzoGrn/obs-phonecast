/**
 * Locating the scrcpy and adb binaries.
 *
 * Deliberate facade: the rest of the code should never know whether the
 * binaries are on the PATH or bundled. The day you bundle the Windows
 * release, this is the only file that changes.
 */

import { execa } from 'execa';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PhonecastError, ErrorCode } from '../errors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '../..');

/**
 * Detects a packaged binary (bun build --compile, Node SEA).
 *
 * Needed because in a standalone executable, `import.meta.url` points to a
 * VIRTUAL path internal to the binary (`/$bunfs/root/...`), not to a
 * location on disk. Resolving `vendor/` relative to it would give a path
 * that doesn't exist. In packaged mode, the only reliable reference is the
 * executable's own location.
 */
function isPackaged() {
  const base = path.basename(process.execPath).toLowerCase();
  return !['node', 'node.exe', 'bun', 'bun.exe'].includes(base);
}

/** Root to use for locating bundled resources. */
function appRoot() {
  return isPackaged() ? path.dirname(process.execPath) : PROJECT_ROOT;
}

const EXE = process.platform === 'win32' ? '.exe' : '';

/** Minimum version: --new-display and --no-vd-system-decorations date from 3.0. */
const MIN_MAJOR = 3;

export class BinaryError extends PhonecastError {}

/**
 * Search order, from most explicit to most implicit:
 *   1. environment variable (escape hatch for advanced users): a full path,
 *      or a bare command name such as "scrcpy" that is looked up in PATH
 *   2. binaries bundled in vendor/ (Windows only in practice)
 *   3. the folder of the scrcpy we already found (adb only): the one that
 *      ships with scrcpy is the one guaranteed compatible with it
 *   4. PATH
 *
 * `bundled` is true ONLY for the vendor/ copy. A path the user chose through
 * the environment is not "bundled", whatever folder it lives in.
 *
 * License reminder: scrcpy is Apache 2.0, redistributing the binaries is
 * allowed. If you populate vendor/, keep the original LICENSE file and
 * credit Genymobile / Romain Vimont in your README.
 */
async function inPath(name) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execa(finder, [name], { reject: true });
    const first = stdout.split(/\r?\n/).find((l) => l.trim());
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

/** A value with no directory part ("scrcpy", "adb.exe") is a command name. */
function isBareCommand(value) {
  return !value.includes('/') && !value.includes('\\');
}

export async function resolveOne(
  name,
  envVar,
  {
    alongside = null,
    env = process.env,
    root = appRoot(),
    exists = existsSync,
    which = inPath,
  } = {},
) {
  const fromEnv = env[envVar];
  if (fromEnv) {
    if (isBareCommand(fromEnv)) {
      const found = await which(fromEnv);
      if (found) return { path: found, bundled: false };
    } else if (exists(fromEnv)) {
      return { path: fromEnv, bundled: false };
    }
  }

  const vendored = path.join(root, 'vendor', 'scrcpy', process.platform, `${name}${EXE}`);
  if (exists(vendored)) return { path: vendored, bundled: true };

  if (alongside) {
    const sibling = path.join(path.dirname(alongside), `${name}${EXE}`);
    if (exists(sibling)) return { path: sibling, bundled: false };
  }

  const found = await which(`${name}${EXE}`);
  if (found) return { path: found, bundled: false };
  return null;
}

/**
 * Fetches the scrcpy version.
 * We read it instead of assuming it: this is what allows a useful error
 * message instead of a confusing "unknown option --new-display".
 */
export async function getScrcpyVersion(scrcpyPath) {
  try {
    const { stdout, stderr } = await execa(scrcpyPath, ['--version'], { reject: false });
    const match = `${stdout}\n${stderr}`.match(/scrcpy\s+v?(\d+)\.(\d+)(?:\.(\d+))?/i);
    if (!match) return null;
    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3] ?? 0),
      raw: `${match[1]}.${match[2]}${match[3] ? `.${match[3]}` : ''}`,
    };
  } catch {
    return null;
  }
}

export async function resolveBinaries({ checkVersion = true } = {}) {
  const scrcpy = await resolveOne('scrcpy', 'OBS_PHONECAST_SCRCPY');
  if (!scrcpy) {
    throw new BinaryError('scrcpy not found.', {
      code: ErrorCode.BINARY_NOT_FOUND,
      hint:
        process.platform === 'win32'
          ? 'Download the Windows release from github.com/Genymobile/scrcpy and add the folder to PATH.'
          : process.platform === 'darwin'
            ? 'Install it with: brew install scrcpy'
            : 'Install it via your package manager (apt install scrcpy, pacman -S scrcpy...).',
    });
  }

  // adb: the one shipped alongside scrcpy is guaranteed compatible. We
  // prefer it, and pass it to scrcpy via the ADB variable it reads natively.
  const adb = await resolveOne('adb', 'OBS_PHONECAST_ADB', { alongside: scrcpy.path });
  if (!adb) {
    throw new BinaryError('adb not found.', {
      code: ErrorCode.BINARY_NOT_FOUND,
      hint: 'Install the Android platform-tools, or use the scrcpy Windows release which includes them.',
    });
  }

  let version = null;
  if (checkVersion) {
    version = await getScrcpyVersion(scrcpy.path);
    if (version && version.major < MIN_MAJOR) {
      throw new BinaryError(
        `scrcpy ${version.raw} is too old: virtual display mode requires version ${MIN_MAJOR}.0 or higher.`,
        {
          code: ErrorCode.BINARY_TOO_OLD,
          hint: 'Update scrcpy, or force mirror mode with --mode=mirror.',
        },
      );
    }
  }

  return {
    scrcpy: scrcpy.path,
    adb: adb.path,
    bundled: scrcpy.bundled,
    version,
    /** Environment to pass to scrcpy processes. */
    env: { ADB: adb.path },
  };
}
