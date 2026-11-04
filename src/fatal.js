/**
 * Process-level safety net for errors nobody caught.
 *
 * History: the first version only logged and carried on ("stream continues
 * if possible"). That is the wrong default for a tool that changes state on
 * the phone: after an unknown exception the process is in an unknown state,
 * and continuing would leave the screen-off timeout extended and scrcpy
 * orphaned if it later died. Now an uncaught error runs the registered
 * cleanups (see registerCleanup in scrcpy/process.js) and exits non-zero.
 *
 * The one exception is a rejection from the OBS websocket client: a dropped
 * connection or a request answered after disconnect is expected during a
 * long stream, is already reported through client.js, and must not take the
 * live scrcpy session down with it.
 *
 * Kept free of heavy imports: index.js loads this before anything else, and
 * --help has to work with no node_modules.
 */

/** True for errors that are known, already handled elsewhere, and harmless. */
export function isBenignRejection(reason) {
  return reason?.name === 'OBSWebSocketError' || reason?.constructor?.name === 'OBSWebSocketError';
}

async function defaultCleanupAndExit(code) {
  try {
    // Dynamic: pulls in execa, which --help must not need.
    const { shutdownAndExit } = await import('./scrcpy/process.js');
    await shutdownAndExit(code);
  } catch {
    process.exit(code);
  }
}

/**
 * @param {object} [options]  all injectable for tests
 */
export function installFatalHandlers({
  proc = process,
  write = (text) => process.stderr.write(text),
  cleanupAndExit = defaultCleanupAndExit,
} = {}) {
  proc.on('uncaughtException', (err) => {
    write(`\nUnhandled exception: ${err?.stack ?? err}\n`);
    void cleanupAndExit(1);
  });

  proc.on('unhandledRejection', (reason) => {
    if (isBenignRejection(reason)) {
      write(`\nOBS websocket rejection ignored (session continues): ${reason?.message ?? reason}\n`);
      return;
    }
    write(`\nUnhandled promise rejection: ${reason?.stack ?? reason}\n`);
    void cleanupAndExit(1);
  });
}
