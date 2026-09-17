/**
 * Text input prompts, with optional masking (for passwords).
 *
 * No external dependency: raw terminal mode plus node:readline is enough
 * for everything needed here.
 */

import readline from 'node:readline';

/**
 * Reads all of stdin eagerly and splits it into lines.
 *
 * Only used when stdin is NOT a TTY (piped input, scripted/non-interactive
 * runs, tests). Real bug hit while testing this file by hand: awaiting
 * between two sequential `rl.question()` calls on a finite piped stream
 * lets the stream's 'end' event fire in the gap, after which readline
 * silently stops servicing further questions -- the second one never
 * resolves, even with a single shared interface and even though
 * `rl.close()` was never called. Reading everything up front sidesteps
 * that race entirely: there's no second `.question()` call left to race.
 */
async function readAllLines() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))))
    .toString('utf8')
    .split(/\r?\n/);
}

/**
 * Builds a prompt function for one interactive session, so a sequence of
 * questions can share whatever underlying mechanism is safe to reuse.
 *
 * - Real TTY: password prompts use raw mode (masked, self-contained, no
 *   readline); plain prompts share one `readline.Interface`. Input
 *   arrives live as the person types, so the EOF race above cannot occur.
 * - Non-TTY (piped, scripted, tests): reads all of stdin once, then hands
 *   out one line per call. No masking is possible or needed here.
 *
 * @returns {(question: string, options?: {mask?: boolean}) => Promise<string>}
 */
export function createPrompt() {
  if (!process.stdin.isTTY) {
    let linesPromise = null;
    let index = 0;
    return async function ask(question) {
      linesPromise ??= readAllLines();
      const lines = await linesPromise;
      const line = lines[index++] ?? '';
      process.stdout.write(`${question}${line}\n`);
      return line;
    };
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return async function ask(question, { mask = false } = {}) {
    if (!mask) {
      return new Promise((resolve) => rl.question(question, resolve));
    }

    return new Promise((resolve) => {
      process.stdout.write(question);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      let value = '';
      const onData = (char) => {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          // Ctrl+C: exit the same way the rest of the CLI does on SIGINT.
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          return;
        }
        value += char;
        process.stdout.write('*');
      };

      function cleanup() {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
      }

      process.stdin.on('data', onData);
    });
  };
}
