/**
 * Everything OS-specific about the OBS integration is confined here.
 *
 * ABSOLUTE RULE: no `process.platform` anywhere else in src/obs/.
 * When the SDL class changes again, or when OBS renames a setting, this
 * is the only file to touch.
 */

import { PhonecastError, ErrorCode } from '../errors.js';

export class PlatformUnsupportedError extends PhonecastError {
  constructor(message, { hint = null } = {}) {
    super(message, { hint, code: ErrorCode.PLATFORM_UNSUPPORTED });
  }
}

/**
 * Detects a Wayland session.
 * Capture there goes through the xdg portal, which forces a system dialog
 * where the user picks the window by hand. No API allows selecting it
 * programmatically: that's a protocol security decision, not a gap in OBS.
 */
export function isWayland() {
  return (
    process.platform === 'linux' &&
    (process.env.XDG_SESSION_TYPE === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY))
  );
}

/**
 * Returns the window-capture descriptor for the current platform.
 *
 * - inputKind      : the source type to create via CreateInput
 * - windowProperty : the name of the property holding the window.
 *                    It DIFFERS by OS, which is why this file exists.
 * - initialSettings: settings to set at creation time, apart from the window
 * - matchStrategy  : how to recognize our window in the returned list
 */
export function getCaptureDescriptor(config = {}) {
  switch (process.platform) {
    case 'win32':
      return {
        inputKind: 'window_capture',
        windowProperty: 'window',
        initialSettings: {
          // 2 = Windows Graphics Capture, forced. This was the original
          // choice; it was replaced at one point with 0 (Automatic) to
          // avoid a silent 0x0 in case WGC wasn't available. In practice,
          // with a Direct3D11-rendered scrcpy window (the common case),
          // the OPPOSITE happens: "Automatic" can resolve to BitBlt, which
          // fails on D3D11 flip-model swapchain windows -- producing
          // exactly the 0x0 it was meant to avoid. Forced WGC is the more
          // reliable choice for this case. `windowCaptureMethod` allows
          // falling back to 0 for a specific environment that needs it
          // (VM, remote GPU, Windows too old for WGC).
          method: config.windowCaptureMethod ?? 2,
          // 0 = "window title must match". Since our title is fixed and
          // unique, OBS will find the window again on its own after a
          // scrcpy restart. Free convenience.
          priority: 0,
          // The mouse cursor on a phone screen makes no sense. Both keys
          // exist depending on the OBS version; an unknown key is simply
          // ignored, so we set both.
          cursor: false,
          capture_cursor: false,
          client_area: true,
        },
        // Windows format: "title:class:executable".
        // The class changed when scrcpy 4.0 moved from SDL2 to SDL3, so we
        // ONLY match on the title.
        matchStrategy: 'prefix',
      };

    case 'darwin':
      return {
        inputKind: 'screen_capture',
        windowProperty: 'window',
        initialSettings: {
          // 1 = window capture (0 = screen, 2 = application).
          // Must be set BEFORE listing: without this type, the window list
          // is empty or absent.
          type: 1,
          show_cursor: false,
          show_empty_names: true,
        },
        // The value is a numeric CGWindowID, which changes on EVERY scrcpy
        // launch. Can't be cached: the list must be re-read on every
        // startup. This is the main difference from Windows.
        matchStrategy: 'substring',
      };

    case 'linux': {
      if (isWayland()) {
        throw new PlatformUnsupportedError(
          'Automatic scene setup is not possible under Wayland.',
          {
            hint:
              'Two options: switch the session to X11, or use the webcam output ' +
              '(--v4l2-sink) which bypasses window capture entirely. ' +
              'Requires the v4l2loopback kernel module.',
          },
        );
      }
      return {
        inputKind: 'xcomposite_input',
        // Note the different name: it's not "window" here.
        windowProperty: 'capture_window',
        initialSettings: {
          show_cursor: false,
        },
        // X11 format: "windowId\r\nname\r\nclass".
        matchStrategy: 'substring',
      };
    }

    default:
      throw new PlatformUnsupportedError(
        `Unsupported platform: ${process.platform}`,
      );
  }
}

/**
 * Descriptor for the V4L2 webcam output, an alternative to window capture.
 * Configured entirely over WebSocket: no list to query, no portal, no
 * window. This is the clean path under Wayland.
 */
export function getV4l2Descriptor(devicePath) {
  if (process.platform !== 'linux') {
    throw new PlatformUnsupportedError('V4L2 is Linux-specific');
  }
  return {
    inputKind: 'v4l2_input',
    windowProperty: null,
    initialSettings: { device_id: devicePath },
    matchStrategy: null,
  };
}

/**
 * Looks for our window in the list returned by OBS.
 *
 * We NEVER build the value ourselves: we take it as-is from the list.
 * That's what makes the code immune to format changes.
 *
 * @param {Array<{itemName: string, itemValue: string|number}>} items
 * @param {string} title window title to find
 * @param {'prefix'|'substring'} strategy
 * @returns {string|number|null} the value to pass as-is to SetInputSettings
 */
export function matchWindowItem(items, title, strategy) {
  if (!Array.isArray(items)) return null;

  for (const item of items) {
    const label = String(item.itemName ?? '');
    const hit =
      strategy === 'prefix'
        ? label === title || label.startsWith(`${title}:`)
        : label.includes(title);
    if (hit) return item.itemValue;
  }

  // Fallback: on some platforms the displayed label and the raw value
  // diverge, so retry against the value.
  for (const item of items) {
    if (String(item.itemValue ?? '').includes(title)) return item.itemValue;
  }

  return null;
}
