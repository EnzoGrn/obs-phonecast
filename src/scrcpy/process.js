/**
 * Launch, monitoring, and clean shutdown of scrcpy.
 *
 * The delicate part of this file is SHUTDOWN, not startup.
 *
 * On Unix, SIGTERM is enough: scrcpy intercepts it, destroys the virtual
 * display on the phone, and exits.
 *
 * On Windows there's no real signal. `child.kill()` ends up calling
 * TerminateProcess, which kills the process without letting it run its own
 * cleanup. Concrete result: an orphaned virtual display stays on the phone,
 * and you need to reboot it or relaunch scrcpy to get rid of it. The fix is
 * `taskkill /T` WITHOUT `/F`, which sends a WM_CLOSE to the window: the SDL
 * loop receives it and exits cleanly. We only escalate to `/F` as a last
 * resort, after a timeout.
 */

import { execa } from 'execa';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';

import { buildArgs, formatCommand } from './args.js';
import { PhonecastError, ErrorCode } from '../errors.js';

/** Number of stderr lines kept for error reports. */
const LOG_RING_SIZE = 60;

export class ScrcpyLaunchError extends PhonecastError {
  constructor(message, { stderr = [], command = null, exitCode = null, hint = null } = {}) {
    super(message, { hint, code: ErrorCode.SCRCPY_LAUNCH_FAILED });
    this.stderr = stderr;
    this.command = command;
    this.exitCode = exitCode;
  }

  /** The command and the last lines are what you want in a bug report. */
  toJSON() {
    return { ...super.toJSON(), command: this.command, stderr: this.stderr.slice(-10) };
  }
}

/**
 * Wraps a scrcpy process.
 *
 * Events emitted:
 *   'log'  (line)                 each stderr line, raw
 *   'exit' ({ exitCode, signal })  process exit, expected or not
 */
export class ScrcpyProcess extends EventEmitter {
  constructor({ binary, args, env = {} }) {
    super();
    this.binary = binary;
    this.args = args;
    this.env = env;
    this.subprocess = null;
    this.exitInfo = null;
    this.stopping = false;
    /** Ring buffer of the last stderr lines. */
    this.logs = [];
  }

  get command() {
    return formatCommand(this.binary, this.args);
  }

  /** True as long as the process is running. This is what waitForWindow polls. */
  isAlive() {
    return Boolean(this.subprocess) && this.exitInfo === null;
  }

  start() {
    if (this.subprocess) throw new Error('Process already started');

    this.subprocess = execa(this.binary, this.args, {
      // stdin ignored: scrcpy doesn't read from it, and an inherited stdin
      // could block if the parent terminal goes away.
      stdin: 'ignore',
      // buffer: false gives streams instead of accumulating in memory. On a
      // multi-hour session, buffering would be a guaranteed leak.
      buffer: false,
      reject: false,
      // Hides the child's console window on Windows (CREATE_NO_WINDOW).
      // Investigated as a suspect during a hard-to-reproduce disconnect bug
      // (real cause turned out to be OBS scene-creation timing on first
      // run, see ROADMAP.md) and ruled out — reverted here to the safer
      // default. Without it, a flashing console box is possible if
      // obs-phonecast is ever launched without an already-visible console
      // (e.g. packaged binary, future GUI dock).
      windowsHide: true,
      env: { ...process.env, ...this.env },
    });

    // scrcpy logs everything to stderr, including its informational messages.
    if (this.subprocess.stderr) {
      const rl = readline.createInterface({ input: this.subprocess.stderr });
      rl.on('line', (line) => {
        this.logs.push(line);
        if (this.logs.length > LOG_RING_SIZE) this.logs.shift();
        // We FORWARD lines, we never INTERPRET them. Log strings change
        // between scrcpy versions; building logic on top of them would
        // reintroduce exactly the fragility we avoid by relying on scrcpy
        // instead of rewriting the pipeline.
        this.emit('log', line);
      });
    }

    this.subprocess.then(
      (result) => this.#onExit(result),
      (result) => this.#onExit(result),
    );

    return this;
  }

  #onExit(result) {
    this.exitInfo = {
      exitCode: result?.exitCode ?? null,
      signal: result?.signal ?? null,
      expected: this.stopping,
    };
    this.emit('exit', this.exitInfo);
  }

  /** Waits for the process to exit, whatever the cause. */
  async waitForExit() {
    if (this.exitInfo) return this.exitInfo;
    return new Promise((resolve) => this.once('exit', resolve));
  }

  /**
   * Clean shutdown, with escalation.
   *
   * @param {number} graceMs time given to cleanup before forcing
   */
  async stop({ graceMs = 4000 } = {}) {
    if (!this.subprocess || this.exitInfo) return this.exitInfo;
    this.stopping = true;

    const pid = this.subprocess.pid;

    if (process.platform === 'win32' && pid) {
      // Without /F: a polite close request, cleanup gets to run.
      // /T to include children (scrcpy spawns adb).
      await execa('taskkill', ['/pid', String(pid), '/T'], { reject: false });
    } else {
      this.subprocess.kill('SIGTERM');
    }

    const exited = await this.#waitWithTimeout(graceMs);
    if (exited) return this.exitInfo;

    // Last resort. Important note: in --v4l2-sink mode there's no window,
    // hence no message loop, hence taskkill without /F always fails and we
    // systematically end up here. That's expected.
    if (process.platform === 'win32' && pid) {
      await execa('taskkill', ['/pid', String(pid), '/T', '/F'], { reject: false });
    } else {
      this.subprocess.kill('SIGKILL');
    }

    await this.#waitWithTimeout(2000);
    return this.exitInfo;
  }

  #waitWithTimeout(ms) {
    if (this.exitInfo) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

/* -------------------------------------------------------------------------- */
/* High-level launch                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Builds the arguments, launches, and checks the process survives the first
 * few hundred milliseconds.
 *
 * This short delay is worth it: a config error or a virtual display refused
 * by the ROM almost always shows up within the first 500ms. Catching it here
 * gives an immediate message instead of waiting for OBS's 15-second timeout.
 */
export async function launch({ binaries, config, onLog = null, settleMs = 600, logger = null }) {
  const args = buildArgs(config);
  const proc = new ScrcpyProcess({
    binary: binaries.scrcpy,
    args,
    env: binaries.env,
  }).start();

  // Essential for diagnosing a gap between "it works by hand" and "it cuts
  // out through obs-phonecast": without this, there's no way to know whether
  // obs-phonecast actually builds the same command as the one tested manually.
  logger?.info(`Command: ${proc.command}`);

  if (onLog) proc.on('log', onLog);

  await new Promise((r) => setTimeout(r, settleMs));

  if (!proc.isAlive()) {
    throw new ScrcpyLaunchError(
      `scrcpy exited immediately (code ${proc.exitInfo?.exitCode}).`,
      { stderr: proc.logs, command: proc.command, exitCode: proc.exitInfo?.exitCode },
    );
  }

  return proc;
}

/**
 * Guarantees no process outlives our own exit, and that async state we
 * changed on the phone or in OBS gets put back.
 *
 * ONE set of process listeners for the whole program, reading a registry of
 * active sessions. Registering per session leaked three listeners every
 * time the dock started a session, and made the cleanup order depend on how
 * many sessions had come and gone.
 *
 * Ctrl+C is handled asynchronously to leave time for cleanup: each entry's
 * processes are stopped and its `hook` (restore the screen-off timeout,
 * disconnect OBS...) is awaited, all bounded by a global timeout so a hung
 * adb can't make the program unkillable. The 'exit' handler is synchronous
 * by nature: it can only do a hard kill, it's a safety net, not the normal
 * path.
 *
 * `proc`, `exit` and `timeoutMs` are injectable so this is testable without
 * touching the real process.
 */
export function createCleanupManager({
  proc: host = process,
  exit = (code) => process.exit(code),
  timeoutMs = 5000,
} = {}) {
  const entries = new Set();
  let installed = false;
  let cleaning = false;

  async function runAll() {
    const tasks = [];
    for (const entry of entries) {
      for (const p of entry.getProcesses()) {
        if (p?.isAlive()) tasks.push(p.stop({ graceMs: 3000 }));
      }
      // Run concurrently with the process stop: restoring a setting over
      // adb does not depend on scrcpy having exited first.
      if (entry.hook) tasks.push(Promise.resolve().then(entry.hook));
    }
    await Promise.allSettled(tasks);
  }

  /** Runs every cleanup (bounded by timeoutMs), then exits with `code`. */
  async function shutdown(code) {
    if (cleaning) {
      // A second signal while cleaning up means "stop waiting".
      exit(code);
      return;
    }
    cleaning = true;
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([runAll(), deadline]);
    clearTimeout(timer);
    exit(code);
  }

  function install() {
    if (installed) return;
    installed = true;
    host.on('SIGINT', () => void shutdown(130));
    host.on('SIGTERM', () => void shutdown(143));
    host.on('exit', () => {
      for (const entry of entries) {
        for (const p of entry.getProcesses()) {
          if (p?.isAlive()) {
            try {
              p.subprocess.kill('SIGKILL');
            } catch {
              /* nothing better to do in a synchronous handler */
            }
          }
        }
      }
    });
  }

  /**
   * @param {() => Array} getProcesses  current processes of this session
   * @param {object} [options]
   * @param {() => Promise<void>} [options.hook]  async cleanup, run on
   *   SIGINT/SIGTERM/fatal error. Must be idempotent.
   * @returns {() => void} unregister, to call once the session ended
   *   normally and cleaned up after itself
   */
  function register(getProcesses, { hook = null } = {}) {
    install();
    const entry = { getProcesses, hook };
    entries.add(entry);
    return () => {
      entries.delete(entry);
    };
  }

  return { register, shutdown, size: () => entries.size };
}

const defaultCleanup = createCleanupManager();

/** See createCleanupManager#register. Process-wide, idempotent. */
export function registerCleanup(getProcesses, options) {
  return defaultCleanup.register(getProcesses, options);
}

/** Runs all registered cleanups, then exits. Used by fatal-error handlers. */
export function shutdownAndExit(code) {
  return defaultCleanup.shutdown(code);
}
