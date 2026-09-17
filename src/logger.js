/**
 * Logging.
 *
 * Two reasons to exist, and the second is the real one.
 *
 * 1. LEVELS. Without them, there's no quiet mode or verbose mode, and raw
 *    scrcpy lines drown out useful messages.
 *
 * 2. A SINGLE, REPLACEABLE OUTPUT POINT. When the browser dock arrives,
 *    logs will need to go to the browser instead of stderr. With a
 *    swappable `sink`, that touches no callers at all.
 *
 * The sink receives a structured RECORD, not an already-formatted string:
 * the dock will want to color-code by level and filter, which a plain
 * string would prevent.
 */

export const LEVELS = Object.freeze({
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
});

const NAMES = ['silent', 'error', 'warn', 'info', 'debug'];

/**
 * Default sink: stderr.
 *
 * stderr, not stdout, so stdout stays clean. `--list-apps` needs to be
 * redirectable to a file or piped into grep without picking up progress
 * messages along the way.
 */
export function stderrSink({ level, message }) {
  const prefix = level === 'error' ? 'Error: ' : level === 'warn' ? 'Warning: ' : '';
  process.stderr.write(`${prefix}${message}\n`);
}

/**
 * In-memory sink, keeping the last N records.
 *
 * Useful for two things down the line: showing history in the dock when it
 * connects after the fact, and attaching context to a bug report.
 */
export function createBufferSink({ max = 500 } = {}) {
  const records = [];
  const sink = (record) => {
    records.push(record);
    if (records.length > max) records.shift();
  };
  sink.records = records;
  sink.dump = () => records.map((r) => `[${r.level}] ${r.message}`).join('\n');
  return sink;
}

/** Broadcasts to multiple sinks. A failing sink doesn't interrupt the others. */
export function combineSinks(...sinks) {
  return (record) => {
    for (const sink of sinks) {
      try {
        sink(record);
      } catch {
        /* logging must never make the caller fail */
      }
    }
  };
}

/**
 * @param {object} options
 * @param {string|number} options.level  threshold, as a name or numeric value
 * @param {Function} options.sink        destination for records
 * @param {string} options.prefix        prefix applied to messages
 */
export function createLogger({ level = 'info', sink = stderrSink, prefix = '' } = {}) {
  let threshold = typeof level === 'number' ? level : (LEVELS[level] ?? LEVELS.info);
  let output = sink;

  const emit = (levelName, message) => {
    if (LEVELS[levelName] > threshold) return;
    output({
      level: levelName,
      message: `${prefix}${message}`,
      time: Date.now(),
    });
  };

  return {
    error: (msg) => emit('error', msg),
    warn: (msg) => emit('warn', msg),
    info: (msg) => emit('info', msg),
    debug: (msg) => emit('debug', msg),

    /** Derived logger, same output, extra prefix. */
    child(childPrefix) {
      return createLogger({
        level: threshold,
        sink: output,
        prefix: `${prefix}${childPrefix}`,
      });
    },

    setLevel(next) {
      threshold = typeof next === 'number' ? next : (LEVELS[next] ?? threshold);
    },

    /** The switchover point for the dock: one call, no caller touched. */
    setSink(next) {
      output = next;
    },

    get level() {
      return NAMES[threshold];
    },

    /** Lets a caller skip an expensive computation if the level excludes it. */
    enabled(levelName) {
      return LEVELS[levelName] <= threshold;
    },
  };
}

/** Inert logger, for tests and calls with no logging. */
export const silentLogger = createLogger({ level: 'silent', sink: () => {} });
