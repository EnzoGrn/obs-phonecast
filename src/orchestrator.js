/**
 * Orchestrator.
 *
 * This is where the tool's added value lives: the full sequence and the
 * automatic FALLBACK. Everything else is just plumbing.
 *
 *   1. binaries
 *   2. adb device, authorized, probed
 *   3. application name resolution
 *   4. OBS connection
 *   5. attempt in VIRTUAL DISPLAY mode
 *   6. wait for the window on the OBS side (15s max)
 *   7a. found -> configure the scene -> monitor
 *   7b. failed -> kill scrcpy, relaunch in MIRROR mode + crop -> back to 6
 *   8. clean shutdown
 *
 * Step 7b is what makes the tool usable for people whose phone you don't
 * know. Virtual-display blocks come from manufacturer ROMs and can't be
 * detected by ANY property ahead of time: the only reliable strategy is to
 * try, then fall back.
 */

import { Mode, deriveCrop, deriveDecorationCrop, WINDOW_TITLE } from './scrcpy/args.js';
import { resolveBinaries } from './scrcpy/binary.js';
import { launch, registerCleanup, ScrcpyLaunchError } from './scrcpy/process.js';
import {
  pickDevice,
  probeDevice,
  getScreenOffTimeout,
  setScreenOffTimeout,
} from './adb/index.js';
import { findApp, looksLikePackage } from './scrcpy/app-list.js';
import { listApps } from './scrcpy/apps.js';
import { connectObs, disconnectObs } from './obs/client.js';
import { setupScene, teardownScene, WindowNotFoundError, SceneError } from './obs/scene.js';
import { isWayland } from './obs/platform.js';
import { silentLogger } from './logger.js';

export async function startSession(config, { logger = silentLogger } = {}) {
  const active = { proc: null };
  registerCleanup(() => [active.proc]);

  // --- 1. Binaries --------------------------------------------------------
  const binaries = await resolveBinaries();
  logger.info(
    `scrcpy ${binaries.version?.raw ?? '?'} ${binaries.bundled ? '(bundled)' : '(PATH)'}`,
  );
  // obs-phonecast forces ADB=<path> onto scrcpy (see binary.js), which can
  // differ from the adb resolved when you launch scrcpy yourself in a
  // terminal. A different adb can behave differently with the TCP/IP
  // transport.
  logger.info(`adb: ${binaries.adb}`);

  // --- 2. Device ------------------------------------------------------------
  const device = await pickDevice(binaries, { serial: config.serial });
  const probe = await probeDevice(binaries, device.serial);

  // Tries to prevent the physical screen from turning off during the session.
  //
  // HONEST CAVEAT: this mechanism was meant to fix the virtual-display
  // blanking documented in scrcpy #6787. But on a device where scrcpy runs
  // WITHOUT obs-phonecast with the screen timeout already at its maximum and
  // never disconnects, while the same session through obs-phonecast still
  // does, this mechanism is NOT the cause of that particular disconnect --
  // the real cause was found elsewhere (see ROADMAP). Kept enabled as a
  // general precaution, but not presented as THE fix.
  //
  // FAILS WITHOUT BLOCKING THE SESSION: some ROMs (confirmed in practice
  // on ColorOS) refuse `adb shell` the WRITE_SETTINGS permission and throw
  // a SecurityException on the write. A convenience extension must never
  // fail startup.
  let originalScreenTimeout = null;
  if (config.extendScreenTimeout) {
    try {
      originalScreenTimeout = await getScreenOffTimeout(binaries, device.serial);
      if (originalScreenTimeout != null) {
        await setScreenOffTimeout(binaries, device.serial, config.screenTimeoutMs);
        logger.info(
          `Screen-off timeout extended to ${Math.round(config.screenTimeoutMs / 60000)} min ` +
            `(restored on exit).`,
        );
      } else {
        logger.warn(
          'Could not read the current screen-off timeout: skipping this setting for safety ' +
            "(we don't want to write a value we couldn't restore).",
        );
      }
    } catch (err) {
      // Write failure (permission denied, hardened ROM...): originalScreenTimeout
      // stays null, so stop() won't try to restore a write that never happened.
      originalScreenTimeout = null;
      logger.warn(
        `Could not extend the screen-off timeout (${err.message}). Set it manually ` +
          'in Settings > Display if disconnects persist.',
      );
    }
  }
  logger.info(
    [
      device.model ?? device.serial,
      probe.sdk ? `Android API ${probe.sdk}` : null,
      probe.width ? `${probe.width}x${probe.height}` : null,
      `nav ${['3-button', '2-button', 'gestures'][probe.navigationMode] ?? '?'}`,
    ]
      .filter(Boolean)
      // Plain ASCII separator, not an em dash: this line is printed to a
      // real user's console, and on Windows, depending on the active code
      // page, a Unicode em dash can render as garbled mojibake instead of
      // a clean line. Comments can afford Unicode; anything printed at
      // runtime can't assume a UTF-8 console.
      .join(' - '),
  );

  // --- 3. Application resolution -------------------------------------------
  // We accept "--app youtube" just as well as the full package name.
  // Do this BEFORE connecting to OBS: no point opening a session only to
  // fail on an app name that can't be found.
  let resolvedApp = config.app;
  if (config.app && !looksLikePackage(config.app)) {
    const { apps, fromCache } = await listApps(binaries, device.serial);
    const app = findApp(apps, config.app);
    resolvedApp = app.package;
    logger.info(`App: ${app.name} [${app.package}]${fromCache ? '' : ' (list refreshed)'}`);
  }

  // --- 4. OBS ---------------------------------------------------------------
  const { obs, obsWebSocketVersion } = await connectObs({ ...config.obs, logger });
  logger.info(`OBS connected (websocket ${obsWebSocketVersion})`);

  // Wayland doesn't allow selecting the window programmatically. Better to
  // say so now than to fail after scrcpy has already launched.
  const useV4l2 = Boolean(config.v4l2Sink);
  if (isWayland() && !useV4l2) {
    logger.warn(
      'Wayland session: automatic scene setup will fail. ' +
        'Use --v4l2 or an X11 session.',
    );
  }

  // --- 5-7. Attempt then fallback -------------------------------------------
  const attempts = buildAttempts({ ...config, app: resolvedApp }, probe);
  let lastError = null;

  for (const [index, attempt] of attempts.entries()) {
    const label =
      attempt.mode === Mode.MIRROR
        ? 'mirror + crop'
        : attempt.launcher
          ? 'virtual display + launcher'
          : 'virtual display';
    if (attempt.launcher) {
      // Most manufacturer launchers (ColorOS, One UI, MIUI...) don't know
      // how to render on a secondary display: only the AOSP launcher
      // handles it correctly. Without a warning, the user just sees a
      // black screen and has no way to tell whether it's a bug or a known
      // limitation.
      logger.warn(
        'launcher mode: if the screen stays black, this phone\'s launcher likely ' +
          'doesn\'t support secondary displays (common outside of stock Android). ' +
          'Check with "scrcpy --new-display=1080x2000/420 ' +
          '--start-app=com.android.settings": if Settings shows up, ' +
          'use --app <name> instead of --launcher on this device.',
      );
    }
    logger.info(`Attempt ${index + 1}/${attempts.length}: ${label}`);

    try {
      const proc = await launch({
        binaries,
        config: attempt,
        // Noisy stream: debug level only, otherwise it drowns out useful messages.
        onLog: (line) => logger.debug(`scrcpy | ${line}`),
        logger,
      });
      active.proc = proc;

      const sceneOptions = {
        sceneName: config.obs.sceneName,
        inputName: config.obs.inputName,
        windowTitle: WINDOW_TITLE,
        v4l2Device: attempt.v4l2Sink,
        switchToScene: config.obs.switchToScene,
        layout: config.layout,
        // Bar cropping only makes sense in launcher mode: without
        // decorations, there's nothing to remove.
        crop:
          attempt.mode === Mode.VIRTUAL && attempt.launcher
            ? (config.decorationCrop ?? deriveDecorationCrop({ dpi: attempt.display.dpi }))
            : null,
        // On the last attempt there's no fallback left: a source that's in
        // place but poorly framed beats no source at all.
        strictFrame: index < attempts.length - 1,
        windowCaptureMethod: config.windowCaptureMethod,
        logger,
      };

      const scene = await setupScene(obs, {
        ...sceneOptions,
        isProcessAlive: () => proc.isAlive(),
      });

      logger.info(
        `Scene ready: "${scene.sceneName}" / "${scene.inputName}" (${scene.inputKind})` +
          (scene.repositioned === false ? ' -- kept your existing position/size' : ''),
      );

      return {
        mode: attempt.mode,
        device: probe,
        scene,
        proc,
        obs,
        // Needed by the watchdog to relaunch identically.
        _relaunch: { binaries, attempt, sceneOptions },
        // `active` is what registerCleanup reads: the watchdog updates it
        // with the new process, otherwise Ctrl+C would kill the old one,
        // already dead.
        _active: active,
        async stop({ removeSource = false } = {}) {
          if (removeSource) await teardownScene(obs, { inputName: scene.inputName });
          // this.proc, not proc: after a restart, the current process is
          // no longer the one captured when the session was created.
          await this.proc.stop();
          if (originalScreenTimeout != null) {
            // Must never make shutdown fail: better to leave the extended
            // timeout in place than to crash session teardown over it.
            await setScreenOffTimeout(binaries, device.serial, originalScreenTimeout).catch(
              (err) => logger.warn(`Failed to restore screen-off timeout: ${err.message}`),
            );
          }
          await disconnectObs(obs);
        },
      };
    } catch (err) {
      lastError = err;
      if (active.proc?.isAlive()) await active.proc.stop();
      active.proc = null;

      if (!isRecoverable(err)) {
        await disconnectObs(obs);
        throw err;
      }

      logger.warn(`failed: ${err.message}`);
      if (err instanceof ScrcpyLaunchError && err.stderr.length) {
        // On failure, surface the raw lines even outside debug mode:
        // this is what the user will paste into a bug report.
        for (const line of err.stderr.slice(-8)) logger.warn(`  scrcpy | ${line}`);
      }
    }
  }

  await disconnectObs(obs);
  throw lastError ?? new Error('No attempt succeeded');
}

/**
 * Builds the ordered list of attempts.
 *
 * If the user explicitly requested a mode, we honor it and don't fall
 * back: a silent fallback when someone asked for specific behavior is more
 * confusing than helpful.
 */
export function buildAttempts(config, probe) {
  // `config.app` is guaranteed here to already be resolved to a package name
  // by startSession.
  const base = {
    serial: probe.serial,
    video: config.video,
    audio: config.audio,
    control: config.control,
    turnScreenOff: config.turnScreenOff,
    stayAwake: config.stayAwake,
    // Forgotten here once already: buildArgs and defaultConfig already
    // handled it, but this explicit list was silently dropping it. Check
    // this list whenever a new field is added to args.js.
    keepActive: config.keepActive,
    v4l2Sink: config.v4l2Sink,
  };

  const virtual = {
    ...base,
    mode: Mode.VIRTUAL,
    display: config.display,
    app: config.app,
    forceStopApp: config.forceStopApp,
    launcher: config.launcher,
    maxSize: null,
    crop: null,
  };

  const mirror = {
    ...base,
    mode: Mode.MIRROR,
    display: config.display,
    app: config.app,
    forceStopApp: false,
    launcher: false,
    maxSize: config.maxSize,
    // Without screen dimensions (probe failed), we can't compute the crop.
    // Stream without a crop rather than refuse to start: a visible nav bar
    // beats no image at all.
    crop:
      config.crop ??
      (probe.width && probe.height
        ? deriveCrop({
            deviceWidth: probe.width,
            deviceHeight: probe.height,
            navigationMode: probe.navigationMode,
            navBarHeight: config.navBarHeight,
            statusBarHeight: config.statusBarHeight,
          })
        : null),
  };

  if (config.mode === Mode.MIRROR) return [mirror];
  if (config.noFallback) return [virtual];
  return [virtual, mirror];
}

/** Only these errors justify trying the next mode. */
function isRecoverable(err) {
  return (
    err instanceof WindowNotFoundError ||
    err instanceof SceneError ||
    err instanceof ScrcpyLaunchError
  );
}

/* -------------------------------------------------------------------------- */
/* Watchdog                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Watches the session and relaunches scrcpy if it dies without being told to.
 *
 * Why this is possible without breaking the scene: the OBS source is bound
 * to the window by its TITLE (priority 0 on Windows), and the title is
 * fixed. A new scrcpy window with the same title is therefore found by OBS
 * on its own. We still replay setupScene for platforms where the window
 * identifier is volatile, such as macOS.
 *
 * During a live stream, a few seconds of interruption is infinitely better
 * than a dead source for the rest of the broadcast.
 *
 * @returns {Promise<{reason: string, exitCode: number|null, restarts: number}>}
 */
export async function watchSession(session, { logger, maxRestarts = 5, delayMs = 2000 } = {}) {
  let restarts = 0;

  for (;;) {
    const exit = await session.proc.waitForExit();

    if (exit.expected) return { reason: 'stopped', exitCode: exit.exitCode, restarts };

    logger.warn(`scrcpy exited unexpectedly (code ${exit.exitCode}).`);
    // The last stderr lines ALWAYS say why. They were only surfaced at
    // debug level: at the moment of a crash, that's exactly what you need
    // to read.
    for (const line of session.proc.logs.slice(-10)) logger.warn(`  scrcpy | ${line}`);

    if (restarts >= maxRestarts) {
      logger.error(`Giving up after ${maxRestarts} restarts.`);
      return { reason: 'gave-up', exitCode: exit.exitCode, restarts };
    }

    restarts += 1;
    logger.warn(`Restarting ${restarts}/${maxRestarts} in ${delayMs} ms...`);
    await new Promise((r) => setTimeout(r, delayMs));

    try {
      const { binaries, attempt, sceneOptions } = session._relaunch;
      const proc = await launch({
        binaries,
        config: attempt,
        onLog: (line) => logger.debug(`scrcpy | ${line}`),
        logger,
      });
      session.proc = proc;
      session._active.proc = proc;

      await setupScene(session.obs, {
        ...sceneOptions,
        strictFrame: false,
        isProcessAlive: () => proc.isAlive(),
      });
      logger.info('Session restored.');
    } catch (err) {
      logger.warn(`Restart failed: ${err.message}`);
    }
  }
}