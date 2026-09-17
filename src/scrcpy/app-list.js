/**
 * Parsing and resolution of the app list.
 *
 * RULE: no side effects, no external dependencies.
 * This is the app-side counterpart of args.js -- testable without a phone
 * and without npm install, and portable to Go as-is.
 *
 * Side effects (calling scrcpy, disk cache) live in apps.js.
 */

import { PhonecastError, ErrorCode } from '../errors.js';

export class AppsError extends PhonecastError {}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Parses the output of `scrcpy --list-apps`.
 *
 * The format changed between scrcpy versions, and BOTH are handled:
 *
 *   with brackets (older versions):
 *     - YouTube                       [com.google.android.youtube]
 *
 *   without brackets, space-aligned columns (scrcpy 4.1+):
 *     - YouTube                       com.google.android.youtube
 *
 * `*` marks a system app, `-` a user-installed app.
 *
 * Without brackets, the package is identified as the LAST whitespace-
 * separated token that looks like a package name (looksLikePackage), not
 * by plain position: an app name can legitimately contain spaces.
 */
export function parseAppList(output) {
  const apps = [];

  for (const raw of String(output ?? '').split(/\r?\n/)) {
    const trimmed = raw.trimEnd().trimStart();
    const marker = trimmed[0];
    if (marker !== '*' && marker !== '-') continue;

    const rest = trimmed.slice(1).trim();
    if (!rest) continue;

    const bracket = rest.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
    let name;
    let pkg;

    if (bracket) {
      name = bracket[1].trim();
      pkg = bracket[2].trim();
    } else {
      // Columns: the last non-blank group must look like a package. Without
      // this check, a malformed entry or one split across two lines
      // (actually observed with an app name containing a line break) would
      // be silently misparsed instead of simply skipped.
      const columns = rest.match(/^(.*\S)\s+(\S+)$/);
      if (columns && looksLikePackage(columns[2])) {
        name = columns[1].trim();
        pkg = columns[2];
      }
    }

    if (!pkg) continue;
    apps.push({ name: name || pkg, package: pkg, system: marker === '*' });
  }

  return apps;
}

/* -------------------------------------------------------------------------- */
/* Resolution by name                                                         */
/* -------------------------------------------------------------------------- */

/** A package name always contains a dot and never a space. */
export function looksLikePackage(value) {
  return typeof value === 'string' && value.includes('.') && !/\s/.test(value);
}

const normalize = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    // Strips accents, so "appareil photo" matches "Appareil photo".
    .replace(/[\u0300-\u036f]/g, '');

/**
 * Resolves `--app youtube` into `com.google.android.youtube`.
 *
 * Priority: exact package, then exact name, then name starting with the
 * query, then name containing it. We stop at the first level that yields a
 * result, which prevents a weak, distant match from competing with a strong
 * one -- without this, "youtube" would be ambiguous against "YouTube Music".
 *
 * On genuine ambiguity we THROW with the list of candidates rather than
 * choosing on the user's behalf: launching the wrong app live on stream is
 * exactly what we want to avoid.
 */
export function findApp(apps, query) {
  if (!query) {
    throw new AppsError('No application requested.', { code: ErrorCode.APPS_NOT_FOUND });
  }

  const q = normalize(query);

  const levels = [
    apps.filter((a) => normalize(a.package) === q),
    apps.filter((a) => normalize(a.name) === q),
    apps.filter((a) => normalize(a.name).startsWith(q)),
    apps.filter((a) => normalize(a.name).includes(q) || normalize(a.package).includes(q)),
  ];

  for (const matches of levels) {
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      // User apps come before system apps: when someone types "photo",
      // they mean their photo app, not a system component.
      const userApps = matches.filter((a) => !a.system);
      if (userApps.length === 1) return userApps[0];

      throw new AppsError(`"${query}" matches ${matches.length} applications.`, {
        code: ErrorCode.APPS_AMBIGUOUS,
        hint: `Be more specific: ${matches
          .slice(0, 8)
          .map((a) => `${a.name} [${a.package}]`)
          .join(', ')}`,
      });
    }
  }

  throw new AppsError(`No application matches "${query}".`, {
    code: ErrorCode.APPS_NOT_FOUND,
    hint: 'List available applications with --list-apps.',
  });
}

/** Formatting for CLI display. */
export function formatAppList(apps, { showSystem = false } = {}) {
  const shown = showSystem ? apps : apps.filter((a) => !a.system);
  if (shown.length === 0) return '';
  const width = Math.min(38, Math.max(...shown.map((a) => a.name.length), 10));
  return shown
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => `  ${a.name.padEnd(width)}  ${a.package}`)
    .join('\n');
}
