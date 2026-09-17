/**
 * Connecting to obs-websocket v5.
 *
 * v5 has been built into OBS since version 28: nothing to install, but it
 * has to be ENABLED under Tools > WebSocket Server Settings. This is the
 * second friction point of the whole tool, after USB authorization, so the
 * error messages here need to be the most explicit in the project.
 */

import OBSWebSocket from 'obs-websocket-js';
import { PhonecastError, ErrorCode } from '../errors.js';

export class ObsConnectionError extends PhonecastError {}

const DEFAULT_PORT = 4455;

export async function connectObs({
  host = 'localhost',
  port = DEFAULT_PORT,
  password = '',
  retries = 3,
  retryDelayMs = 1500,
  logger = null,
} = {}) {
  const obs = new OBSWebSocket();
  const url = `ws://${host}:${port}`;

  // CRITICAL, a real bug we actually hit: obs-websocket-js exposes
  // OBSWebSocket as an EventEmitter. If the socket emits 'error' AFTER the
  // connection (a network blip, an expired ping...) with NO listener
  // attached, Node treats an unlistened 'error' event as an unhandled
  // exception and CRASHES THE ENTIRE PROCESS. Our own cleanup on
  // process.on('exit') then killed scrcpy immediately, believing it was
  // cleaning up after a normal exit. Observed result: a disconnect with no
  // error line whatsoever on the scrcpy side, after a variable delay
  // (10 to 15s) that had nothing to do with scrcpy itself.
  //
  // This listener must be attached BEFORE any `await obs.connect(...)`,
  // since the event can occur as early as the connection attempt.
  obs.on('error', (err) => {
    logger?.warn(`OBS websocket: non-fatal error caught (${err?.message ?? err})`);
  });

  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const { obsWebSocketVersion, negotiatedRpcVersion } = await obs.connect(
        url,
        password || undefined,
      );
      return { obs, obsWebSocketVersion, rpcVersion: negotiatedRpcVersion, url };
    } catch (err) {
      lastError = err;

      // A wrong password won't fix itself by retrying: bail out immediately.
      if (isAuthError(err)) {
        throw new ObsConnectionError('WebSocket password rejected by OBS.', {
          code: ErrorCode.OBS_AUTH_FAILED,
          hint:
            'Copy it from OBS: Tools > WebSocket Server Settings > Show ' +
            'Connect Info.',
        });
      }

      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }

  throw new ObsConnectionError(`Could not connect to ${url}.`, {
    code: ErrorCode.OBS_CONNECT_FAILED,
    cause: lastError,
    hint:
      'Check that OBS is running, then under Tools > WebSocket Server Settings that ' +
      `"Enable WebSocket server" is checked and the port is indeed ${port}. ` +
      `Detail: ${lastError?.message ?? 'unknown'}`,
  });
}

function isAuthError(err) {
  // obs-websocket returns 4009 for a rejected authentication.
  return err?.code === 4009 || /auth/i.test(err?.message ?? '');
}

/** Tolerant disconnect: safe to call even if the connection already dropped. */
export async function disconnectObs(obs) {
  try {
    await obs.disconnect();
  } catch {
    /* already closed */
  }
}
