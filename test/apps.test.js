import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAppList,
  findApp,
  looksLikePackage,
  formatAppList,
  AppsError,
} from '../src/scrcpy/app-list.js';

// Note: app names are deliberately kept in their original language (French,
// with accents) since some tests specifically exercise accent-insensitive
// matching and multi-word names -- this is realistic sample data pulled
// from an actual device, not something to translate away.
const SAMPLE = `List of apps:
 * Appareil photo                        [com.android.camera]
 * Fichiers                              [com.android.documentsui]
 - YouTube                               [com.google.android.youtube]
 - YouTube Music                         [com.google.android.apps.youtube.music]
 - Instagram                             [com.instagram.android]
`;

const APPS = parseAppList(SAMPLE);

/* --- parseAppList ----------------------------------------------------------- */

test('parses the five entries and ignores the header', () => {
  assert.equal(APPS.length, 5);
});

test('distinguishes system apps (*) from user apps (-)', () => {
  assert.equal(APPS.find((a) => a.package === 'com.android.camera').system, true);
  assert.equal(APPS.find((a) => a.package === 'com.instagram.android').system, false);
});

test('name and package correctly separated', () => {
  const yt = APPS.find((a) => a.package === 'com.google.android.youtube');
  assert.equal(yt.name, 'YouTube');
});

test('a label containing brackets doesn\'t break parsing', () => {
  // We split on the LAST bracket: the package name never contains one.
  const apps = parseAppList(' - Game [beta]                 [com.example.game]');
  assert.equal(apps.length, 1);
  assert.equal(apps[0].name, 'Game [beta]');
  assert.equal(apps[0].package, 'com.example.game');
});

test('stray lines are ignored', () => {
  const apps = parseAppList('INFO: something\n\nWARN: something else\n');
  assert.deepEqual(apps, []);
});

test('empty output: empty array, no exception', () => {
  assert.deepEqual(parseAppList(''), []);
});

/* --- looksLikePackage -------------------------------------------------------- */

test('recognizes a package name', () => {
  assert.equal(looksLikePackage('com.instagram.android'), true);
});

test('a readable name is not a package', () => {
  assert.equal(looksLikePackage('YouTube'), false);
  assert.equal(looksLikePackage('Google Maps'), false);
});

/* --- findApp ------------------------------------------------------------------ */

test('exact package', () => {
  assert.equal(findApp(APPS, 'com.instagram.android').name, 'Instagram');
});

test('exact name, case-insensitive', () => {
  assert.equal(findApp(APPS, 'instagram').package, 'com.instagram.android');
});

test('exact name wins over a shared prefix', () => {
  // "YouTube" also matches the prefix of "YouTube Music": the "exact name"
  // level must win before we fall through to the prefix level.
  assert.equal(findApp(APPS, 'youtube').package, 'com.google.android.youtube');
});

test('unique prefix accepted', () => {
  assert.equal(
    findApp(APPS, 'youtube mu').package,
    'com.google.android.apps.youtube.music',
  );
});

test('accents ignored', () => {
  assert.equal(findApp(APPS, 'appareil photo').package, 'com.android.camera');
});

test('at equal level, user apps come before system apps', () => {
  // Both match at the "prefix" level, so the preference is the tiebreaker.
  const apps = [
    { name: 'System Photos', package: 'com.android.gallery', system: true },
    { name: 'Photos Pro', package: 'com.example.photos', system: false },
  ];
  assert.equal(findApp(apps, 'photos').package, 'com.example.photos');
});

test('an exact name wins over the user/system preference', () => {
  // Deliberate choice: an exact match is a stronger signal than "it's a
  // user app". Someone who types exactly "Photos" wants the app literally
  // named Photos, even if it's a system one.
  const apps = [
    { name: 'Photos', package: 'com.android.gallery', system: true },
    { name: 'Photos Pro', package: 'com.example.photos', system: false },
  ];
  assert.equal(findApp(apps, 'photos').package, 'com.android.gallery');
});

test('genuine ambiguity: throws with the list of candidates', () => {
  const apps = [
    { name: 'Chat A', package: 'com.a.chat', system: false },
    { name: 'Chat B', package: 'com.b.chat', system: false },
  ];
  assert.throws(
    () => findApp(apps, 'chat'),
    (err) => {
      assert.ok(err instanceof AppsError);
      assert.match(err.hint, /Chat A/);
      assert.match(err.hint, /Chat B/);
      return true;
    },
  );
});

test('no match: AppsError pointing to --list-apps', () => {
  // assert.throws checks the MESSAGE, not the hint: the hint is what
  // carries the action to take, so we check it explicitly.
  assert.throws(
    () => findApp(APPS, 'zzz'),
    (err) => {
      assert.ok(err instanceof AppsError);
      assert.match(err.message, /zzz/);
      assert.match(err.hint, /--list-apps/);
      return true;
    },
  );
});

/* --- formatAppList ------------------------------------------------------------ */

test('formatAppList hides system apps by default', () => {
  const out = formatAppList(APPS);
  assert.ok(out.includes('Instagram'));
  assert.ok(!out.includes('com.android.camera'));
});

test('formatAppList --all-apps includes system apps and sorts by name', () => {
  const lines = formatAppList(APPS, { showSystem: true }).split('\n');
  assert.equal(lines.length, 5);
  assert.match(lines[0], /Appareil photo/);
});

/* --- scrcpy 4.1+ format, no brackets -------------------------------------------- */

const SAMPLE_NO_BRACKETS = ` * Appareil photo                 com.oplus.camera
 * Gestionnaire du téléphone      com.coloros.phonemanager
 - YouTube                        com.google.android.youtube
 - YouTube Music                  com.google.android.apps.youtube.music
 - Instagram                      com.instagram.android`;

const APPS_NB = parseAppList(SAMPLE_NO_BRACKETS);

test('bracket-less format: all five entries are parsed', () => {
  assert.equal(APPS_NB.length, 5);
});

test('bracket-less format: name and package are correct', () => {
  const yt = APPS_NB.find((a) => a.package === 'com.google.android.youtube');
  assert.equal(yt.name, 'YouTube');
});

test('bracket-less format: a name containing spaces stays intact', () => {
  const app = APPS_NB.find((a) => a.package === 'com.coloros.phonemanager');
  assert.equal(app.name, 'Gestionnaire du téléphone');
});

test('bracket-less format: system vs user is still distinguished', () => {
  assert.equal(APPS_NB.find((a) => a.package === 'com.oplus.camera').system, true);
  assert.equal(APPS_NB.find((a) => a.package === 'com.instagram.android').system, false);
});

test('an entry split across two lines is skipped without crashing', () => {
  // Real case observed: an app name containing a line break. The first
  // half has no trailing token that looks like a package -> skipped. The
  // second half doesn't start with a marker -> skipped too. That entry is
  // lost, but nothing crashes and neighboring entries aren't corrupted.
  const output = [
    ' - YouTube                        com.google.android.youtube',
    ' - Split App',
    '   Name Continued                    com.example.split',
    ' - Instagram                      com.instagram.android',
  ].join('\n');
  const apps = parseAppList(output);
  assert.equal(apps.length, 2);
  assert.ok(apps.some((a) => a.package === 'com.google.android.youtube'));
  assert.ok(apps.some((a) => a.package === 'com.instagram.android'));
});

test('both formats are handled within the same output', () => {
  const mixed = [
    ' - Old Format                     [com.example.old]',
    ' - New Format                     com.example.new',
  ].join('\n');
  const apps = parseAppList(mixed);
  assert.equal(apps.length, 2);
  assert.equal(apps[0].package, 'com.example.old');
  assert.equal(apps[1].package, 'com.example.new');
});
