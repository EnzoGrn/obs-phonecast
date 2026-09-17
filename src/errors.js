/**
 * Project errors.
 *
 * Three problems the base class solves that seven independent classes
 * did not:
 *
 * 1. The `hint` contract was a CONVENTION redeclared seven times. `index.js`
 *    duck-typed on `err.hint` with no guarantee the field existed.
 *
 * 2. There was no way to tell a USER-FACING error apart from a BUG. A
 *    TypeError displayed exactly like "device not authorized", which is
 *    misleading: in one case the user needs to act, in the other they need
 *    to open an issue.
 *
 * 3. No stable identifier. A future dock will need to show contextual help
 *    without parsing messages that can change or get translated.
 *
 * This file has NO dependencies at all, including internal ones: it's
 * imported by app-list.js and args.js, which must stay pure.
 */

/**
 * Stable codes. These are what the dock and the tests use, never the
 * message text. Additions are free, renames are breaking.
 */
export const ErrorCode = Object.freeze({
  UNKNOWN: 'UNKNOWN',

  // Configuration
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_UNREADABLE: 'CONFIG_UNREADABLE',

  // Binaries
  BINARY_NOT_FOUND: 'BINARY_NOT_FOUND',
  BINARY_TOO_OLD: 'BINARY_TOO_OLD',

  // adb
  ADB_NO_DEVICE: 'ADB_NO_DEVICE',
  ADB_UNAUTHORIZED: 'ADB_UNAUTHORIZED',
  ADB_OFFLINE: 'ADB_OFFLINE',
  ADB_MULTIPLE_DEVICES: 'ADB_MULTIPLE_DEVICES',
  ADB_DEVICE_NOT_FOUND: 'ADB_DEVICE_NOT_FOUND',
  ADB_COMMAND_FAILED: 'ADB_COMMAND_FAILED',

  // Applications
  APPS_EMPTY: 'APPS_EMPTY',
  APPS_AMBIGUOUS: 'APPS_AMBIGUOUS',
  APPS_NOT_FOUND: 'APPS_NOT_FOUND',

  // scrcpy
  SCRCPY_LAUNCH_FAILED: 'SCRCPY_LAUNCH_FAILED',

  // OBS
  OBS_CONNECT_FAILED: 'OBS_CONNECT_FAILED',
  OBS_AUTH_FAILED: 'OBS_AUTH_FAILED',
  OBS_SCENE_FAILED: 'OBS_SCENE_FAILED',
  OBS_WINDOW_NOT_FOUND: 'OBS_WINDOW_NOT_FOUND',
  OBS_SOURCE_TYPE_MISMATCH: 'OBS_SOURCE_TYPE_MISMATCH',
  OBS_NO_FRAME: 'OBS_NO_FRAME',

  // Platform
  PLATFORM_UNSUPPORTED: 'PLATFORM_UNSUPPORTED',
});

/**
 * Any expected error from the project.
 *
 * `expected: true` means: this is not a bug, the user can do something
 * about it. Anything that doesn't inherit from this class is a bug.
 */
export class PhonecastError extends Error {
  constructor(message, { hint = null, code = ErrorCode.UNKNOWN, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    // new.target gives the name of the actually instantiated subclass,
    // which avoids redeclaring it in every constructor.
    this.name = new.target.name;
    this.hint = hint;
    this.code = code;
    this.expected = true;
  }

  /** Representation meant for the dock and bug reports. */
  toJSON() {
    return { name: this.name, code: this.code, message: this.message, hint: this.hint };
  }
}

/** Distinguishes a user-facing error from a bug. Used by the final `catch`. */
export function isExpectedError(err) {
  return err instanceof PhonecastError;
}

/**
 * Full message, message and hint combined.
 *
 * In a single block because the logger's sink prefixes "Error: ": two
 * separate calls would put that prefix in front of the hint too, which
 * isn't an error but the action to take.
 */
export function formatError(err) {
  if (!isExpectedError(err)) return err?.message ?? String(err);
  return err.hint ? `${err.message}\n\n${err.hint}` : err.message;
}
