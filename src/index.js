#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * Deliberately framework-free: node:util/parseArgs is more than enough at
 * this prototype stage, and it keeps the dependency tree to two entries.
 */

import { parseArgs } from 'node:util';
import { exec } from 'node:child_process';

import { loadConfig, configPath, wrapParseArgsError, parsePort } from './config.js';
import { Mode } from './scrcpy/args.js';
import { createLogger } from './logger.js';
import { installFatalHandlers } from './fatal.js';
import { isExpectedError, formatError } from './errors.js';

// The orchestrator is imported dynamically inside main(): it pulls in
// execa and obs-websocket-js, and --help must work BEFORE any npm install.
// That's the first command anyone discovering the tool will run.

// Uncaught errors restore state (screen timeout, OBS) and exit non-zero; see
// fatal.js for why this no longer carries on, and the one benign exception.
installFatalHandlers();

const options = {
  app: { type: 'string' },
  mode: { type: 'string' },
  serial: { type: 'string' },
  dpi: { type: 'string' },
  size: { type: 'string' },
  bitrate: { type: 'string' },
  fps: { type: 'string' },
  encoder: { type: 'string' },
  audio: { type: 'boolean' },
  control: { type: 'boolean' },
  'obs-password': { type: 'string' },
  'obs-port': { type: 'string' },
  scene: { type: 'string' },
  v4l2: { type: 'string' },
  'no-fallback': { type: 'boolean' },
  'no-restart': { type: 'boolean' },
  'no-keep-active': { type: 'boolean' },
  borderless: { type: 'boolean' },
  'extend-screen-timeout': { type: 'boolean' },
  'capture-method': { type: 'string' },
  launcher: { type: 'boolean', short: 'l' },
  'crop-top': { type: 'string' },
  'crop-bottom': { type: 'string' },
  'list-apps': { type: 'boolean' },
  'refresh-apps': { type: 'boolean' },
  'all-apps': { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  verbose: { type: 'boolean', short: 'v' },
  switch: { type: 'boolean' },
  init: { type: 'boolean' },
  force: { type: 'boolean' },
  dock: { type: 'boolean' },
  'dock-port': { type: 'string' },
  'dock-host': { type: 'string' },
  'no-open': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const HELP = `
obs-phonecast -- stream an Android phone's screen into OBS

  obs-phonecast --app com.example.app

Setup
  --init               interactive setup: asks for the OBS WebSocket
                       password and a default app, writes the config file.
                       Won't overwrite an existing one unless --force is
                       also passed.

  --dock               start a local web panel instead of a CLI session:
                       app picker, start/stop button, live log feed. Add
                       it in OBS as a Custom Browser Dock (Docks menu) at
                       the URL printed on startup. The underlying session
                       still goes through the same code as everything
                       else in this file -- the dock is a remote control,
                       not a separate implementation.
  --dock-port <n>      port for the dock server (default 7412)
  --dock-host <addr>   address the dock server binds to (default
                       127.0.0.1, this machine only). Passing anything
                       else exposes the panel -- and the ability to read
                       or overwrite your OBS password -- to that address's
                       reach; only do this on a network you trust.
  --no-open            don't automatically open the dock URL in the
                       default browser (it opens by default, so someone
                       who isn't comfortable with a terminal still sees
                       proof it's working without copying a URL by hand).

Applications
  --list-apps          list the phone's applications, then exit
  --all-apps           include system apps in --list-apps
  --refresh-apps       ignore the cache (7 days) and reload the list

Capture
  --app <name|package> application to launch on the virtual display.
                       Accepts a partial name: --app youtube
                       Optional with --launcher.

  -l, --launcher       keep the virtual display's system decorations.
                       You get a launcher: free navigation between apps,
                       switching apps live without relaunching. In
                       exchange, a status bar and a nav bar appear -- but
                       on the VIRTUAL screen, so notifications stay on the
                       physical screen. These bars are cropped
                       automatically on the OBS side.
                       WARNING: only works if the phone's launcher
                       supports secondary displays. Most manufacturer
                       launchers (ColorOS, One UI, MIUI...) don't, and
                       show a black screen instead. Stock Android and
                       third-party launchers (Fossify...) work.

  --crop-top <px>      adjust bar cropping if the automatic value is off
  --crop-bottom <px>   (computed from DPI by default)
  --mode <m>           virtual (default) or mirror
  --no-fallback        don't fall back to mirror mode if the virtual display fails
  --no-restart         don't relaunch scrcpy if it exits on its own
                       (default: up to 5 automatic restarts)
  --no-keep-active     disable --keep-active. It's enabled and recommended
                       by default (it's the officially documented scrcpy
                       workaround for virtual displays going black after
                       idle); note it did NOT, by itself, fix a separate
                       disconnect issue we investigated (see
                       --extend-screen-timeout below and ROADMAP.md).
  --borderless         hide the scrcpy window's title bar and OS border
                       on this PC. Off by default: OBS already captures
                       just the video content regardless, so keeping the
                       normal title bar gives you a real window you can
                       move, minimize, or close by hand.
  --extend-screen-timeout  extends the physical screen's sleep timeout to
                       30 min for the session (restored on exit). OFF BY
                       DEFAULT: its premise (fixing a documented scrcpy
                       disconnect, #6787) turned out not to hold in
                       practice -- a similar disconnect was observed even
                       with the screen timeout already disabled manually.
                       Fails silently (a warning, no crash) on ROMs that
                       refuse WRITE_SETTINGS to adb shell (confirmed on
                       ColorOS).
  --capture-method <n> Windows only. Forces the OBS capture method:
                       0 auto, 1 BitBlt, 2 WGC (default, recommended for
                       a D3D11-rendered window like scrcpy's).
  --serial <s>         target device when several are plugged in
  --size <WxH>         virtual display resolution (default 1080x2000)
  --dpi <n>            density: controls element SIZE, not sharpness.
                       400-440 is a good starting point for streaming.

Video
  --bitrate <b>        default 16M. The transport is local, be generous.
  --fps <n>            match your OBS scene's framerate
  --encoder <name>     force a specific encoder (see scrcpy --list-encoders).
                       First thing to try if the image has artifacts.
  --audio              also capture the phone's audio (Android 11+)
  --control            allow mouse control. Implied by --app and by
                       --launcher (launching an app, or driving the
                       launcher, both go through the control channel);
                       without either, scrcpy runs read-only.

OBS
  --obs-port <n>       default 4455
  --obs-password <p>   TROUBLESHOOTING ONLY: visible in shell history and
                       in the process list. Prefer the config file or
                       OBS_PHONECAST_PASSWORD.
  --scene <name>       default "Phone"
  --switch             switch to the scene once set up
  --v4l2 <device>      webcam output (Linux, requires v4l2loopback)

OBS password
  It's generated by OBS, you don't make it up. Get it from
  Tools > WebSocket Server Settings > Show Connect Info. Three ways to
  provide it:

    1. config file (recommended, set it once)
       ${configPath()}
       { "obs": { "password": "..." } }

    2. environment variable
       OBS_PHONECAST_PASSWORD  (also _PORT and _HOST)

    3. --obs-password  (see the warning above)

  If you unchecked "Enable Authentication" in OBS, leave this blank: the
  connection will proceed without a password.

Output
  -q, --quiet          only show errors
  -v, --verbose        also show raw scrcpy lines

  Messages go to stderr: stdout stays clean, so
  "obs-phonecast --list-apps > apps.txt" only captures the list.

Priority: CLI arguments > environment > file > defaults
`;

function parseSize(value) {
  const m = /^(\d+)x(\d+)$/.exec(value ?? '');
  if (!m) throw new Error(`invalid --size: "${value}" (expected format 1080x2000)`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

function buildOverrides(values) {
  const o = {};
  if (values.app) o.app = values.app;
  if (values.serial) o.serial = values.serial;
  if (values['no-fallback']) o.noFallback = true;
  if (values['no-keep-active']) o.keepActive = false;
  if (values.borderless) o.windowBorderless = true;
  if (values['extend-screen-timeout']) o.extendScreenTimeout = true;
  if (values['capture-method']) o.windowCaptureMethod = Number(values['capture-method']);
  if (values.launcher) o.launcher = true;

  const crop = {};
  if (values['crop-top']) crop.top = Number(values['crop-top']);
  if (values['crop-bottom']) crop.bottom = Number(values['crop-bottom']);
  if (Object.keys(crop).length) o.decorationCrop = crop;
  if (values.v4l2) o.v4l2Sink = values.v4l2;

  if (values.mode) {
    if (!Object.values(Mode).includes(values.mode)) {
      throw new Error(`invalid --mode: "${values.mode}" (virtual or mirror)`);
    }
    o.mode = values.mode;
  }

  const display = {};
  if (values.size) Object.assign(display, parseSize(values.size));
  if (values.dpi) display.dpi = Number(values.dpi);
  if (Object.keys(display).length) o.display = display;

  const video = {};
  if (values.bitrate) video.bitrate = values.bitrate;
  if (values.fps) video.maxFps = Number(values.fps);
  if (values.encoder) video.encoder = values.encoder;
  if (Object.keys(video).length) o.video = video;

  if (values.audio) o.audio = { enabled: true };
  if (values.control) o.control = { enabled: true };

  const obs = {};
  if (values['obs-password']) obs.password = values['obs-password'];
  if (values['obs-port']) obs.port = parsePort(values['obs-port'], '--obs-port');
  if (values.scene) obs.sceneName = values.scene;
  if (values.switch) obs.switchToScene = true;
  if (Object.keys(obs).length) o.obs = obs;

  return o;
}

/**
 * A single logger for the whole process. The level comes from the flags,
 * and the sink stays stderr until the dock exists.
 */
function logLevelFor(values) {
  return values.quiet ? 'error' : values.verbose ? 'debug' : 'info';
}

function makeLogger(values) {
  return createLogger({ level: logLevelFor(values) });
}

/**
 * --list-apps: short, self-contained path.
 * Doesn't connect to OBS, doesn't launch scrcpy in capture mode. Someone
 * looking up their app's name hasn't necessarily set up OBS yet.
 */
async function printApps(config, values, logger) {
  const { resolveBinaries } = await import('./scrcpy/binary.js');
  const { pickDevice } = await import('./adb/index.js');
  const { listApps, formatAppList } = await import('./scrcpy/apps.js');

  const binaries = await resolveBinaries();
  const device = await pickDevice(binaries, { serial: config.serial });

  if (!values['refresh-apps']) logger.info('Reading the application list...');
  const { apps, fromCache, fetchedAt } = await listApps(binaries, device.serial, {
    refresh: Boolean(values['refresh-apps']),
  });

  process.stdout.write(`${formatAppList(apps, { showSystem: Boolean(values['all-apps']) })}\n`);

  const hiddenSystemCount = apps.filter((a) => a.system).length;
  const shown = values['all-apps'] ? apps.length : apps.length - hiddenSystemCount;
  logger.info(
    `\n${shown} applications` +
      (fromCache
        ? ` (cached from ${new Date(fetchedAt).toLocaleString()}, --refresh-apps to reload)`
        : '') +
      // A real trap this avoided: manufacturers frequently preinstall
      // ordinary, wanted apps (YouTube, Chrome, Camera...) as "system"
      // apps, indistinguishable in kind from actually-boring OS
      // components. Someone hiding this note would see their app simply
      // missing and reasonably conclude something was broken, when it was
      // only hidden from this LIST -- --app <name> resolution itself never
      // excludes system apps, only this listing does.
      (!values['all-apps'] && hiddenSystemCount > 0
        ? `\n${hiddenSystemCount} system app(s) hidden (--all-apps to include them -- some ` +
          `manufacturer-preinstalled apps, like YouTube or Chrome, are marked "system" too)`
        : ''),
  );
}

/**
 * Best-effort: opens the system default browser at the given URL.
 *
 * Deliberately non-fatal on failure -- this runs on a headless server, or
 * a machine with no browser configured, often enough that it must never
 * take the dock down with it. Uses the OS's own "open a URL" command
 * rather than a package, since it's a single fire-and-forget call and
 * node:child_process is already built in.
 */
function openInBrowser(url, logger) {
  const command =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;

  exec(command, (err) => {
    if (err) {
      logger.debug(`Could not auto-open a browser (${err.message}). Open the URL above by hand.`);
    }
  });
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options, allowPositionals: false }));
  } catch (err) {
    throw wrapParseArgsError(err);
  }

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const logger = makeLogger(values);

  if (values.init) {
    const { runInit } = await import('./init.js');
    await runInit({ logger, force: Boolean(values.force) });
    return;
  }

  if (values.dock) {
    const { startDockServer } = await import('./server/index.js');
    const port = values['dock-port'] ? parsePort(values['dock-port'], '--dock-port') : undefined;
    const host = values['dock-host'] || undefined;
    const { url, close } = await startDockServer({
      port,
      host,
      logger,
      logLevel: logLevelFor(values),
    });

    logger.info('');
    logger.info(`Dock ready at ${url}`);
    logger.info('In OBS: Docks menu > Custom Browser Docks, paste that URL, give it a name.');
    logger.info('Ctrl+C to stop.');

    if (!values['no-open']) {
      openInBrowser(url, logger);
    }

    // Keep the process alive until interrupted; the HTTP server already
    // does this on its own, but an explicit handler lets us close cleanly
    // instead of leaving the port bound after a hard kill.
    await new Promise((resolve) => {
      const shutdown = async () => {
        await close();
        resolve();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
    return;
  }

  const config = await loadConfig(buildOverrides(values));

  if (values['list-apps']) {
    await printApps(config, values, logger);
    return;
  }

  const { startSession, watchSession } = await import('./orchestrator.js');
  const session = await startSession(config, { logger });

  logger.info('');
  logger.info(`Ready. Mode: ${session.mode}. Ctrl+C to stop.`);

  // The watchdog relaunches scrcpy if it dies for no reason, and returns
  // control once the user stops it themselves or after too many failures.
  const result = await watchSession(session, {
    logger,
    maxRestarts: values['no-restart'] ? 0 : 5,
  });
  if (result.restarts > 0) logger.info(`${result.restarts} restart(s) during the session.`);
  await session.stop();
}

main().catch((err) => {
  // Dedicated 'error'-level logger: a fatal error must come out even under
  // --quiet, and even if the crash happened before the logger was created.
  const fatal = createLogger({ level: 'error' });

  if (isExpectedError(err)) {
    // User-facing error: the user can act on it. Message and hint in the
    // SAME record, otherwise the sink's "Error: " prefix would end up in
    // front of the hint too, which isn't an error but the action to take.
    fatal.error(formatError(err));
    process.exitCode = 1;
    return;
  }

  // Everything else is a BUG. Distinguishing the two avoids sending the
  // user off to look for what they did wrong when they didn't do
  // anything, and the call stack is what's needed in a bug report.
  fatal.error(
    `${err?.message ?? err}\n\n` +
      `This is an obs-phonecast bug, not a configuration error.\n` +
      `Please open an issue with the trace below.`,
  );
  process.stderr.write(`\n${err?.stack ?? ''}\n`);
  process.exitCode = 2;
});