/**
 * Building scrcpy arguments.
 *
 * ABSOLUTE RULE FOR THIS FILE: no side effects.
 * No spawning, no disk reads, no adb calls, no console.log.
 * A config goes in, an array of strings comes out.
 *
 * This is the only module testable without a phone or OBS, and the one
 * you'd port to Go almost line for line.
 */

import { PhonecastError, ErrorCode } from '../errors.js';

/**
 * Window title, deliberately NOT configurable.
 * This is the lookup key on the OBS side: if the user could change it,
 * the whole automatic scene setup would become fragile.
 */
export const WINDOW_TITLE = 'OBS-PHONECAST';

export const Mode = Object.freeze({
  /** Virtual display: notifications and nav bar stay on the physical screen. */
  VIRTUAL: 'virtual',
  /** Mirror of the real screen + crop. Plan B when the virtual display is blocked. */
  MIRROR: 'mirror',
});

const CODECS = new Set(['h264', 'h265', 'av1']);

/** Reference config. `config.js` merges on top of this. */
export const defaultConfig = Object.freeze({
  mode: Mode.VIRTUAL,
  serial: null,

  // VIRTUAL mode only.
  display: { width: 1080, height: 2000, dpi: 420 },
  app: null,
  forceStopApp: false,

  /**
   * Launcher mode: KEEP the virtual display's system decorations.
   * You get a launcher, hence free navigation between apps and switching
   * apps on the fly without relaunching scrcpy. The cost is a status bar
   * and a nav bar -- but on the VIRTUAL screen, so notifications stay on
   * the physical screen. The main benefit holds. These bars get cropped
   * on the OBS side, where the geometry is known in advance.
   */
  launcher: false,

  // MIRROR mode only.
  maxSize: 1200,
  crop: null,

  video: {
    codec: 'h264',
    bitrate: '16M',
    maxFps: 60,
    bufferMs: 0,
    encoder: null,
  },

  audio: { enabled: false },
  control: { enabled: false },

  turnScreenOff: false,
  stayAwake: false,
  /**
   * Prevents the virtual display from being flagged idle and blanked by
   * Android.
   *
   * Documented scrcpy workaround (issues #6787, #5604): without direct
   * interaction on the virtual display, a 10-SECOND countdown starts as
   * soon as the PHYSICAL screen turns off, after which the virtual
   * display goes black. `--keep-active` is the officially documented fix
   * for that specific symptom.
   *
   * Honest caveat, confirmed on real hardware: on at least one device we
   * tested against, a session still disconnected intermittently even with
   * `--keep-active` on AND the physical screen kept on throughout -- so
   * this flag alone did not explain or fix that particular symptom. The
   * actual root cause found in that case was unrelated (an OBS
   * scene-creation timing issue on first launch -- see ROADMAP.md). Kept
   * enabled by default anyway since it's cheap, documented upstream, and
   * may still help on other devices/ROMs. Different from `stayAwake`
   * (`--stay-awake`), which keeps the physical screen from turning off
   * but requires the device to be charging -- `--keep-active` has no such
   * requirement.
   */
  keepActive: true,

  /**
   * Removes the scrcpy client window's OS title bar and borders on the
   * PC side. Off by default: OBS's window capture already crops to just
   * the client area (`client_area: true` in obs/platform.js), so a
   * decorated window doesn't leak into the captured frame -- keeping the
   * normal title bar just gives you a real window you can move, minimize,
   * or close by hand, without affecting what viewers see.
   */
  windowBorderless: false,

  /** Path like /dev/video2. Linux only, bypasses the window entirely. */
  v4l2Sink: null,
});

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export class ConfigError extends PhonecastError {
  constructor(message, { hint = null, code = ErrorCode.CONFIG_INVALID } = {}) {
    super(message, { hint, code });
  }
}

const BITRATE_RE = /^\d+(\.\d+)?[KM]?$/;

/**
 * Validates the config and throws an explicit ConfigError.
 * We validate here rather than letting scrcpy fail: scrcpy's own message
 * is correct, but the user won't know which field of their config to fix.
 */
export function validateConfig(config) {
  if (!Object.values(Mode).includes(config.mode)) {
    throw new ConfigError(
      `invalid mode: "${config.mode}" (expected "virtual" or "mirror")`,
    );
  }

  const { video } = config;
  if (!CODECS.has(video.codec)) {
    throw new ConfigError(
      `invalid video.codec: "${video.codec}" (expected h264, h265, or av1)`,
    );
  }
  if (typeof video.bitrate === 'string' && !BITRATE_RE.test(video.bitrate)) {
    throw new ConfigError(
      `invalid video.bitrate: "${video.bitrate}" (examples: 16M, 8000K, 12000000)`,
    );
  }
  if (video.maxFps != null && (!Number.isInteger(video.maxFps) || video.maxFps < 1)) {
    throw new ConfigError(`invalid video.maxFps: ${video.maxFps}`);
  }
  if (video.bufferMs != null && (video.bufferMs < 0 || video.bufferMs > 1000)) {
    throw new ConfigError(
      `video.bufferMs out of range: ${video.bufferMs} (0-1000 ms)`,
    );
  }

  if (config.mode === Mode.VIRTUAL) {
    const d = config.display ?? {};
    if (!Number.isInteger(d.width) || !Number.isInteger(d.height) || d.width < 1 || d.height < 1) {
      throw new ConfigError('display.width / display.height must be positive integers');
    }
    if (!Number.isInteger(d.dpi) || d.dpi < 120 || d.dpi > 640) {
      throw new ConfigError(
        `display.dpi out of range: ${d.dpi} (120-640; 400-440 is a good starting point for streaming)`,
      );
    }
    // With --no-vd-system-decorations there's no launcher on the virtual
    // display: without a starting app, scrcpy displays nothing. In launcher
    // mode the decorations stay, so the app becomes optional.
    if (!config.app && !config.launcher) {
      throw new ConfigError(
        'virtual mode: "app" is required unless "launcher": true',
        {
          hint:
            'Pass --app <name> to launch a specific application, or --launcher ' +
            'to navigate freely on the virtual display.',
        },
      );
    }
  }

  if (config.mode === Mode.MIRROR && config.crop) {
    const c = config.crop;
    for (const k of ['width', 'height', 'x', 'y']) {
      if (!Number.isInteger(c[k]) || c[k] < 0) {
        throw new ConfigError(`crop.${k} must be an integer >= 0`);
      }
    }
  }

  if (config.v4l2Sink && process.platform !== 'linux') {
    throw new ConfigError('v4l2Sink is only available on Linux');
  }
}

/* -------------------------------------------------------------------------- */
/* Crop derivation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Typical heights in pixels based on `settings get secure navigation_mode`.
 * These are deliberate estimates: getting the exact value requires digging
 * into `dumpsys window`, whose format varies between Android versions.
 * We provide a reasonable default and let the user adjust it once.
 */
const NAV_BAR_HEIGHT_BY_MODE = { 0: 132, 1: 132, 2: 48 };

/**
 * Computes the crop to apply in mirror mode.
 *
 * CAUTION: scrcpy applies --crop in the device's NATURAL orientation,
 * before any rotation. The coordinates passed here must therefore be those
 * from `wm size`, not those of the screen as currently displayed.
 */
export function deriveCrop({
  deviceWidth,
  deviceHeight,
  navigationMode = 0,
  navBarHeight = null,
  statusBarHeight = 0,
}) {
  if (!Number.isInteger(deviceWidth) || !Number.isInteger(deviceHeight)) {
    throw new ConfigError('deriveCrop: deviceWidth and deviceHeight are required');
  }
  const nav = navBarHeight ?? NAV_BAR_HEIGHT_BY_MODE[navigationMode] ?? 132;
  const height = deviceHeight - nav - statusBarHeight;
  if (height < 1) {
    throw new ConfigError('deriveCrop: resulting height is zero or negative');
  }
  return { width: deviceWidth, height, x: 0, y: statusBarHeight };
}

/**
 * Decoration crop for launcher mode, to apply on the OBS side.
 *
 * Unlike the mirror-mode crop, the geometry is KNOWN: we created the
 * virtual display ourselves, so we set its DPI. Android sizes its bars in
 * dp, so the conversion is direct:
 *   pixels = dp x dpi / 160
 *
 * 24dp for the status bar and 48dp for the nav bar are Android's standard
 * values. They stay adjustable, since a manufacturer could deviate from them.
 */
export function deriveDecorationCrop({ dpi, statusBarDp = 24, navBarDp = 48 }) {
  const toPx = (dp) => Math.round((dp * dpi) / 160);
  return { top: toPx(statusBarDp), bottom: toPx(navBarDp), left: 0, right: 0 };
}

/* -------------------------------------------------------------------------- */
/* Building                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} config
 * @returns {string[]} arguments to pass as-is to execa (never as a string)
 */
export function buildArgs(config) {
  validateConfig(config);

  const args = [];

  // -s accepts both a serial number and an "IP:port" over Wi-Fi.
  if (config.serial) args.push('-s', config.serial);

  if (config.mode === Mode.VIRTUAL) {
    const { width, height, dpi } = config.display;
    args.push(`--new-display=${width}x${height}/${dpi}`);
    if (!config.launcher) {
      // Removes the status bar, the nav bar, AND the launcher.
      args.push('--no-vd-system-decorations');
    }
    if (config.app) {
      args.push(`--start-app=${config.forceStopApp ? '+' : ''}${config.app}`);
    }
  } else {
    if (config.maxSize) args.push(`--max-size=${config.maxSize}`);
    if (config.crop) {
      const { width, height, x, y } = config.crop;
      args.push(`--crop=${width}:${height}:${x}:${y}`);
    }
  }

  // --- Video -----------------------------------------------------------------
  const { video } = config;
  args.push(`--video-codec=${video.codec}`);
  args.push(`--video-bit-rate=${video.bitrate}`);
  if (video.maxFps) args.push(`--max-fps=${video.maxFps}`);
  if (video.bufferMs) args.push(`--video-buffer=${video.bufferMs}`);
  // Fallback for hardware encoders that produce artifacts. First thing to
  // try when someone reports "the image looks weird".
  if (video.encoder) args.push(`--video-encoder=${video.encoder}`);

  // --- Audio -------------------------------------------------------------------
  // scrcpy's default is audio ON (Android 11+), so we explicitly disable it.
  // For streaming, people usually prefer to capture phone audio some other
  // way, and an unused track costs latency.
  if (!config.audio.enabled) args.push('--no-audio');

  // --- Output ------------------------------------------------------------------
  if (config.v4l2Sink) {
    // Webcam output: no window to capture, so no title to set.
    args.push(`--v4l2-sink=${config.v4l2Sink}`);
    args.push('--no-window');
  } else {
    args.push(`--window-title=${WINDOW_TITLE}`);
    if (config.windowBorderless) args.push('--window-borderless');
  }

  // --- Misc --------------------------------------------------------------------
  // scrcpy REFUSES to start an app if control is disabled ("Cannot start an
  // Android app if control is disabled"): launching an app goes through the
  // control channel. So the two can't be combined. Control is enabled
  // implicitly rather than failing: with no app, we keep --no-control, which
  // avoids accidental clicks.
  if (!config.control.enabled && !config.app) args.push('--no-control');
  args.push('--disable-screensaver');
  if (config.turnScreenOff) args.push('--turn-screen-off');
  if (config.stayAwake) args.push('--stay-awake');
  if (config.keepActive) args.push('--keep-active');

  return args;
}

/** Displayable version, for logs and bug reports. */
export function formatCommand(binary, args) {
  const quote = (a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a);
  return [binary, ...args].map(quote).join(' ');
}