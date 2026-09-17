/**
 * `--init`: interactive first-run setup.
 *
 * Removes the worst moment of the current experience: having to hand-create
 * a JSON file in an OS-specific folder before obs-phonecast can even connect to
 * OBS. Asks for the two things people actually get stuck on -- the OBS
 * WebSocket password, and which app to launch by default -- and writes them
 * to the config file.
 *
 * The interactive part (`createPrompt`) is injected rather than called
 * directly, so the flow itself stays testable without a real TTY.
 */

import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

import { configPath } from './config.js';
import { createPrompt } from './prompt.js';

/** Pure: turns collected answers into the object to write as JSON. */
export function buildInitConfig({ password = '', app = '' } = {}) {
  const config = { obs: { password: password.trim() } };
  const trimmedApp = app.trim();
  if (trimmedApp) config.app = trimmedApp;
  return config;
}

export async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} options
 * @param {object} options.logger
 * @param {boolean} options.force   overwrite an existing config file
 * @param {string|null} options.file  override the target path (used by tests)
 * @param {Function|null} options.prompt  override for the ask(question, opts)
 *   function (used by tests); defaults to a fresh createPrompt() session
 */
export async function runInit({
  logger,
  force = false,
  file = null,
  prompt = null,
} = {}) {
  const target = file ?? configPath();

  if (!force && (await fileExists(target))) {
    logger.info(`A config file already exists at ${target}.`);
    logger.info('Edit it directly, or run with --init --force to overwrite it.');
    return { created: false, path: target };
  }

  logger.info("Let's set up obs-phonecast.");
  logger.info(
    'Get the OBS WebSocket password from OBS: Tools > WebSocket Server Settings > Show Connect Info.',
  );

  const ask = prompt ?? createPrompt();

  const password = await ask(
    'OBS WebSocket password (leave blank if authentication is disabled): ',
    { mask: true },
  );

  const app = await ask(
    'Default app to launch, e.g. "youtube" (leave blank to pass --app each time): ',
  );

  const config = buildInitConfig({ password, app });

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  logger.info('');
  logger.info(`Config written to ${target}`);
  logger.info('You can edit this file directly any time, or delete it and run --init again.');

  return { created: true, path: target };
}
