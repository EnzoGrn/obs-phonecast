/**
 * adb layer.
 *
 * Facade: the rest of the code never parses adb output itself.
 */

import { execa } from 'execa';
import { PhonecastError, ErrorCode } from '../errors.js';

export class AdbError extends PhonecastError {}

/**
 * A single adb call, with one retry.
 *
 * The retry exists for wireless: an isolated command occasionally fails
 * over a TCP transport, where it would always succeed over USB. A single
 * retry is enough in practice and avoids failing the whole session for
 * nothing.
 */
async function adb(binaries, args, { serial = null, timeoutMs = 20_000, retries = 1 } = {}) {
  const full = serial ? ['-s', serial, ...args] : args;
  let last = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = await execa(binaries.adb, full, {
      reject: false,
      timeout: timeoutMs,
      windowsHide: true,
    });

    if (result.exitCode === 0) return result.stdout.trim();
    last = result;

    if (attempt < retries) await new Promise((r) => setTimeout(r, 400));
  }

  // Required detail: `stderr || stdout` can be EMPTY (timeout, killed
  // process), in which case the message said absolutely nothing. The exit
  // code and the timeout flag are what makes this diagnosable.
  const detail =
    (last?.stderr || last?.stdout || '').trim() ||
    (last?.timedOut ? `no response after ${timeoutMs} ms` : `code ${last?.exitCode ?? '?'}`);

  throw new AdbError(`adb ${full.join(' ')} failed: ${detail}`, {
    code: ErrorCode.ADB_COMMAND_FAILED,
    hint:
      serial && serial.includes(':')
        ? 'Unstable wireless connection. Check "adb devices -l", or switch back to USB.'
        : 'Check that the cable is properly plugged in and that "adb devices" lists the device.',
  });
}

/* -------------------------------------------------------------------------- */
/* Devices                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Parses `adb devices -l`.
 * The three states to distinguish are device / unauthorized / offline: they
 * each call for a different action from the user.
 */
export async function listDevices(binaries) {
  const out = await adb(binaries, ['devices', '-l']);
  return out
    .split(/\r?\n/)
    .slice(1) // "List of devices attached" header
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/);
      const meta = {};
      for (const token of rest) {
        const [k, v] = token.split(':');
        if (k && v) meta[k] = v;
      }
      return {
        serial,
        state,
        model: meta.model ?? null,
        wireless: /^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial),
      };
    });
}

/**
 * Picks a device and turns problematic states into actionable messages.
 * The `unauthorized` state is by far the first problem new users run into:
 * it deserves explicit wording.
 */
export async function pickDevice(binaries, { serial = null } = {}) {
  const devices = await listDevices(binaries);

  if (devices.length === 0) {
    throw new AdbError('No device detected.', {
      code: ErrorCode.ADB_NO_DEVICE,
      hint:
        'Check that USB debugging is enabled (Settings > Developer options), ' +
        'that the cable is plugged in, and that the phone is set to "File ' +
        'transfer" mode rather than "Charging only".',
    });
  }

  if (serial) {
    const found = devices.find((d) => d.serial === serial);
    if (!found) {
      throw new AdbError(`Device "${serial}" not found.`, {
        code: ErrorCode.ADB_DEVICE_NOT_FOUND,
        hint: `Detected: ${devices.map((d) => d.serial).join(', ')}`,
      });
    }
    assertUsable(found);
    return found;
  }

  const usable = devices.filter((d) => d.state === 'device');

  if (usable.length === 0) {
    assertUsable(devices[0]);
  }
  if (usable.length > 1) {
    throw new AdbError('Multiple devices connected.', {
      code: ErrorCode.ADB_MULTIPLE_DEVICES,
      hint: `Specify which one with --serial: ${usable
        .map((d) => `${d.serial}${d.model ? ` (${d.model})` : ''}`)
        .join(', ')}`,
    });
  }

  return usable[0];
}

function assertUsable(device) {
  if (device.state === 'unauthorized') {
    throw new AdbError(`Device ${device.serial} is not authorized.`, {
      code: ErrorCode.ADB_UNAUTHORIZED,
      hint:
        'Check the phone\'s screen: an "Allow USB debugging?" dialog is waiting for ' +
        'your confirmation. Check "Always allow from this computer" then relaunch.',
    });
  }
  if (device.state === 'offline') {
    throw new AdbError(`Device ${device.serial} is offline.`, {
      code: ErrorCode.ADB_OFFLINE,
      hint:
        'Unplug and replug the cable. If it persists, "adb kill-server" usually ' +
        'fixes it -- run it yourself: killing it automatically would break the ' +
        'session of any other tool sharing the same adb server.',
    });
  }
  if (device.state !== 'device') {
    throw new AdbError(`Unexpected state for ${device.serial}: ${device.state}`, {
      code: ErrorCode.ADB_COMMAND_FAILED,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Properties                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * API level. PURELY INFORMATIONAL: it only feeds one log line, so its
 * failure must never interrupt the session. Virtual-display blocks come
 * from manufacturer ROMs, not from the API level: relying on it to decide
 * anything wouldn't be useful anyway.
 */
export async function getSdkLevel(binaries, serial) {
  try {
    const out = await adb(binaries, ['shell', 'getprop', 'ro.build.version.sdk'], { serial });
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * 0 = three-button, 1 = two-button, 2 = gestures.
 * Used to guess the height to crop in mirror mode.
 */
export async function getNavigationMode(binaries, serial) {
  try {
    const out = await adb(binaries, ['shell', 'settings', 'get', 'secure', 'navigation_mode'], {
      serial,
    });
    const n = Number(out);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0; // absent on older ROMs: the three-button default is the safest bet
  }
}

/**
 * Screen dimensions, in the device's NATURAL orientation.
 *
 * `wm size` can return two lines: "Physical size" and "Override size" when
 * a custom resolution is active. The override is what matters, since it's
 * what scrcpy actually captures -- hence the priority order.
 */
export async function getScreenSize(binaries, serial) {
  const out = await adb(binaries, ['shell', 'wm', 'size'], { serial });
  const override = out.match(/Override size:\s*(\d+)x(\d+)/);
  const physical = out.match(/Physical size:\s*(\d+)x(\d+)/);
  const match = override ?? physical;
  if (!match) {
    throw new AdbError(`Could not read screen size: ${out}`, {
      code: ErrorCode.ADB_COMMAND_FAILED,
    });
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * Device context.
 *
 * None of these three pieces of information is required to start: SDK
 * level and navigation mode only feed a log line and a crop default, and
 * screen size is only used for the mirror-mode crop. We fetch them with
 * allSettled: a failure degrades the information, it doesn't interrupt
 * the session.
 */
export async function probeDevice(binaries, serial) {
  const [sdk, navigationMode, size] = await Promise.allSettled([
    getSdkLevel(binaries, serial),
    getNavigationMode(binaries, serial),
    getScreenSize(binaries, serial),
  ]);

  return {
    serial,
    sdk: sdk.status === 'fulfilled' ? sdk.value : null,
    navigationMode: navigationMode.status === 'fulfilled' ? navigationMode.value : 0,
    width: size.status === 'fulfilled' ? size.value.width : null,
    height: size.status === 'fulfilled' ? size.value.height : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Screen-off timeout                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Physical screen's sleep timeout, in milliseconds.
 *
 * Background: a documented scrcpy issue (#6787) has the virtual display go
 * black 10 seconds after the physical screen turns off. Extending this
 * timeout was our first attempt at working around it.
 *
 * IMPORTANT, confirmed on real hardware: this is NOT a proven fix for that
 * symptom. On at least one tested device, a very similar-looking
 * disconnect happened even with the screen timeout already maxed out
 * manually and the physical screen staying on throughout -- so extending
 * it here provided no benefit in that case. The actual cause found for
 * that disconnect was unrelated (see ROADMAP.md). This mechanism is kept,
 * disabled by default, as a low-cost, unproven precaution for other
 * devices -- not presented as a guaranteed fix.
 */
export async function getScreenOffTimeout(binaries, serial) {
  try {
    const out = await adb(binaries, ['shell', 'settings', 'get', 'system', 'screen_off_timeout'], {
      serial,
    });
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function setScreenOffTimeout(binaries, serial, ms) {
  await adb(binaries, ['shell', 'settings', 'put', 'system', 'screen_off_timeout', String(ms)], {
    serial,
  });
}

/* -------------------------------------------------------------------------- */
/* Wireless                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Switches a USB-connected device to a TCP/IP connection.
 * The cable can then be unplugged.
 *
 * Android 11+'s cable-free pairing (six-digit code, variable mDNS port) is
 * a nice-to-have to add later, not part of the prototype.
 */
export async function enableWireless(binaries, serial, { port = 5555 } = {}) {
  const ipOut = await adb(binaries, ['shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0'], {
    serial,
  });
  const ip = ipOut.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/)?.[1];
  if (!ip) {
    throw new AdbError('Wi-Fi IP address not found.', {
      code: ErrorCode.ADB_COMMAND_FAILED,
      hint: 'The phone must be connected to the same Wi-Fi network as the PC.',
    });
  }

  await adb(binaries, ['tcpip', String(port)], { serial });
  // Switching to TCP mode restarts the adb daemon on the phone.
  await new Promise((r) => setTimeout(r, 1500));
  await adb(binaries, ['connect', `${ip}:${port}`]);

  return `${ip}:${port}`;
}
