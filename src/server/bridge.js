/**
 * Bridges the dock (browser UI, over WebSocket) to the orchestrator.
 *
 * One bridge per server process manages AT MOST ONE active session --
 * mirrors how the CLI itself works. This isn't a multi-session manager,
 * it's a remote control for the same single-session orchestrator the CLI
 * already uses.
 *
 * Kept independent of WebSocket itself: `broadcast` is an injected
 * function, and the orchestrator/adb/scrcpy modules are lazily imported
 * (default) or injected (tests), same reasoning as index.js's --help path
 * and init.js's prompt injection -- so this file stays testable without a
 * phone, without OBS, and without pulling in execa at load time.
 */

import { silentLogger, createLogger, createBufferSink, combineSinks } from '../logger.js';
import { loadConfig } from '../config.js';
import { readRawConfig, writeRawConfig } from '../settings.js';

const defaultDeps = {
  async loadOrchestrator() {
    return import('../orchestrator.js');
  },
  async loadAdb() {
    return import('../adb/index.js');
  },
  async loadBinary() {
    return import('../scrcpy/binary.js');
  },
  async loadApps() {
    return import('../scrcpy/apps.js');
  },
};

/**
 * @param {object} options
 * @param {(message: object) => void} options.broadcast  sends a
 *   JSON-serializable message to every connected dock client
 * @param {object} options.deps  override for the lazy module loaders above
 *   (tests only)
 * @param {string|null} options.configFile  override for the config file
 *   path (tests only); defaults to the real configPath()
 */
export function createBridge({ broadcast, deps = defaultDeps, configFile = null } = {}) {
  let session = null;
  let watching = null; // the in-flight watchSession() promise, if any

  // Kept so a dock that connects AFTER the session already started still
  // sees everything that happened so far -- this is exactly what
  // createBufferSink's docstring in logger.js was built for.
  const history = createBufferSink({ max: 300 });

  const logger = createLogger({
    level: 'info',
    sink: combineSinks(history, (record) => broadcast({ type: 'log', record })),
  });

  function status() {
    return session ? 'running' : 'idle';
  }

  async function start({ app = null, launcher = false } = {}) {
    if (session) {
      throw new Error('A session is already running. Stop it before starting another.');
    }

    const overrides = {};
    if (app) overrides.app = app;
    if (launcher) overrides.launcher = true;
    const config = await loadConfig(overrides);

    const { startSession, watchSession } = await deps.loadOrchestrator();

    session = await startSession(config, { logger });
    broadcast({ type: 'status', state: status(), mode: session.mode });

    // Not awaited here on purpose: watchSession blocks until the session
    // ends, and start() must return as soon as the session is UP, not
    // once it's over. Its eventual resolution is what flips `session`
    // back to null and tells connected docks the run has ended.
    watching = watchSession(session, { logger }).then((result) => {
      session = null;
      watching = null;
      broadcast({ type: 'status', state: status(), reason: result.reason });
    });
  }

  async function stop() {
    if (!session) return;
    await session.stop();
    // watchSession's own loop observes the expected exit and resolves on
    // its own -- awaiting `watching` here (rather than broadcasting a
    // second time ourselves) avoids a race between two status messages.
    if (watching) await watching;
  }

  async function listApps({ refresh = false } = {}) {
    const config = await loadConfig();
    const { resolveBinaries } = await deps.loadBinary();
    const { pickDevice } = await deps.loadAdb();
    const { listApps: listAppsImpl } = await deps.loadApps();

    const binaries = await resolveBinaries();
    const device = await pickDevice(binaries, { serial: config.serial });
    return listAppsImpl(binaries, device.serial, { refresh });
  }

  /** Replays buffered log history to one newly-connected client. */
  function replayHistoryTo(send) {
    for (const record of history.records) send({ type: 'log', record });
  }

  /**
   * Returns exactly what's stored in the config file today -- not the
   * merged, defaults-included config a running session actually uses.
   * That distinction matters: the dock's settings form should only ever
   * show and persist what the user has explicitly chosen, not bake in
   * every default the moment they open the panel.
   */
  async function getConfig() {
    return readRawConfig(configFile);
  }

  /**
   * Persists a config object as-is. The dock is expected to have loaded
   * the current file first (getConfig), edited only the fields its form
   * exposes, and sent back the WHOLE object -- so any advanced key the
   * form doesn't show (set by hand, or by --init) survives a save
   * untouched rather than being silently dropped.
   */
  async function saveConfig(config) {
    return writeRawConfig(config, configFile);
  }

  return {
    start,
    stop,
    listApps,
    status,
    replayHistoryTo,
    getConfig,
    saveConfig,
    logger,
  };
}

export { silentLogger };
