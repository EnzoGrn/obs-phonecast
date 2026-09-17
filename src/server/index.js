/**
 * Dock server: one HTTP server serving the dock's single-page UI, plus a
 * WebSocket endpoint on the same port for the dock <-> bridge protocol.
 *
 * Protocol (all messages are JSON objects with a "type" field):
 *
 *   dock -> server
 *     { type: 'start', app?, launcher? }   start a session
 *     { type: 'stop' }                     stop the current session
 *     { type: 'listApps', refresh? }       list installed applications
 *     { type: 'getConfig' }                read the current config file
 *     { type: 'saveConfig', config }       write the config file
 *
 *   server -> dock
 *     { type: 'status', state: 'idle'|'running', mode?, reason? }
 *     { type: 'apps', apps }
 *     { type: 'config', config }           reply to getConfig
 *     { type: 'configSaved' }              reply to saveConfig
 *     { type: 'log', record }              one logger record (see logger.js)
 *     { type: 'error', message, bug }      bug=true means it's not the
 *                                          dock's fault, same distinction
 *                                          the CLI makes for itself
 *
 * SECURITY, deliberately handled here rather than left implicit:
 *
 * This server can read AND overwrite the OBS WebSocket password (through
 * getConfig/saveConfig), and can start or stop a live session. Two things
 * protect that:
 *
 * 1. It binds to 127.0.0.1 by default, not 0.0.0.0. `server.listen(port)`
 *    with no host argument binds to every network interface -- anyone on
 *    the same Wi-Fi could otherwise reach the full control panel,
 *    including the password. `host` is configurable (--dock-host) for
 *    someone who genuinely wants to drive the dock from another device on
 *    their LAN, but that's an explicit, logged opt-in, not the default.
 *
 * 2. It rejects browser-initiated WebSocket connections whose Origin
 *    header isn't this same server. A WebSocket handshake, unlike a
 *    fetch() request, is NOT subject to the same-origin policy by
 *    default -- any webpage open in a normal browser on the same machine
 *    (a malicious ad, a compromised tab) could otherwise open a
 *    connection to a localhost server and issue commands through it. This
 *    is a known vulnerability class for local dev servers and Electron-
 *    style local control panels. Non-browser clients (a raw `ws` client,
 *    this project's own tests) send no Origin header at all and are still
 *    allowed -- there's no reliable way to authenticate those differently,
 *    so the real protection this adds is specifically against a
 *    THIRD-PARTY WEBPAGE, not against another local process (which is a
 *    threat model no local, unauthenticated tool fully solves).
 *
 * `ws` is already a transitive dependency of obs-websocket-js, so adding
 * it here as a direct one costs nothing extra in practice.
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { createBridge } from './bridge.js';
import { isExpectedError, formatError } from '../errors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCK_HTML_PATH = path.resolve(HERE, '../../web/index.html');

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Pure, so it's directly testable: does this Origin header belong to a
 * page served by OUR server on this port?
 *
 * @param {string|undefined} origin  the WebSocket handshake's Origin header
 * @param {number} port
 */
export function isAllowedOrigin(origin, port) {
  if (!origin) return true; // no Origin: not a browser context, see note above
  try {
    const url = new URL(origin);
    // url.hostname brackets an IPv6 literal ("[::1]"); the raw --dock-host
    // value and this parsed value use different conventions for the same
    // address, so normalize rather than maintaining two loopback sets.
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    return LOOPBACK_HOSTNAMES.has(hostname) && url.port === String(port);
  } catch {
    return false;
  }
}

/**
 * @param {object} options
 * @param {number} options.port
 * @param {string} options.host  defaults to loopback-only; see the
 *   security note above before changing this
 * @param {object} options.logger
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
export async function startDockServer({ port = 7412, host = '127.0.0.1', logger } = {}) {
  const dockHtml = await readFile(DOCK_HTML_PATH, 'utf8');

  if (!LOOPBACK_HOSTNAMES.has(host)) {
    logger?.warn(
      `Dock server bound to ${host}, not just this machine. Anyone who can reach that ` +
        'address on your network can control this session and read or change your OBS ' +
        'password. Only do this on a network you trust.',
    );
  }

  const httpServer = http.createServer((req, res) => {
    // Single-page dock: every GET serves the same file, no router needed.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(dockHtml);
  });

  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: (info, callback) => {
      callback(isAllowedOrigin(info.origin, port));
    },
  });
  const clients = new Set();

  function broadcast(message) {
    const payload = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  const bridge = createBridge({ broadcast });

  wss.on('connection', (ws) => {
    clients.add(ws);
    const send = (message) => ws.send(JSON.stringify(message));

    send({ type: 'status', state: bridge.status() });
    bridge.replayHistoryTo(send);

    ws.on('message', async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        send({ type: 'error', message: 'Malformed message (not valid JSON).', bug: false });
        return;
      }

      try {
        if (message.type === 'start') {
          await bridge.start({ app: message.app, launcher: message.launcher });
        } else if (message.type === 'stop') {
          await bridge.stop();
        } else if (message.type === 'listApps') {
          const { apps } = await bridge.listApps({ refresh: Boolean(message.refresh) });
          send({ type: 'apps', apps });
        } else if (message.type === 'getConfig') {
          const config = await bridge.getConfig();
          send({ type: 'config', config });
        } else if (message.type === 'saveConfig') {
          await bridge.saveConfig(message.config ?? {});
          send({ type: 'configSaved' });
        } else {
          send({ type: 'error', message: `Unknown message type: ${message.type}`, bug: false });
        }
      } catch (err) {
        // Same distinction the CLI makes for itself: a user-facing error
        // gets its message and hint; anything else is a bug and should
        // say so rather than pretend the dock user did something wrong.
        send({
          type: 'error',
          message: isExpectedError(err) ? formatError(err) : `Internal error: ${err.message}`,
          bug: !isExpectedError(err),
        });
      }
    });

    ws.on('close', () => clients.delete(ws));
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      logger?.info(`Dock server listening at http://${host}:${port}`);
      resolve({
        url: `http://${host === '::1' ? 'localhost' : host}:${port}`,
        close: () =>
          new Promise((r) => {
            wss.close();
            httpServer.close(() => r());
          }),
      });
    });
  });
}
