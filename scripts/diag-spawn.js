/**
 * Isolated diagnostic: reproduces ONLY the execa spawn, with no
 * orchestrator, no OBS, no adb layer on top. Used to determine whether a
 * disconnect comes from the spawn mechanics themselves or from everything
 * else around them.
 *
 * Manual developer tool, not part of the CLI. Kept in the repo because the
 * bug-hunting session that produced it may come in handy again -- see the
 * "windowsHide" investigation in ROADMAP.md for how it was used and what
 * it ruled out (spoiler: the spawn mechanics were not the cause; the real
 * root cause was an OBS scene-creation timing issue, also documented
 * there).
 *
 * Usage:
 *   node scripts/diag-spawn.js -s 10.28.254.139:5555
 *
 * Then compare against the "Command: ..." line from your last obs-phonecast
 * log, or leave the args below as-is to reuse this default reproduction.
 */
import { execa } from 'execa';

const serial = process.argv[2] === '-s' ? process.argv[3] : null;
const args = [
  ...(serial ? ['-s', serial] : []),
  '--new-display=1080x2000/420',
  '--no-vd-system-decorations',
  '--start-app=com.google.android.youtube',
  '--video-codec=h264',
  '--video-bit-rate=16M',
  '--max-fps=60',
  '--no-audio',
  '--window-title=OBS-PHONECAST',
  '--window-borderless',
  '--disable-screensaver',
  '--keep-active',
];

console.log('Command:', 'scrcpy', args.join(' '));
console.log('Start:', new Date().toISOString());

const start = Date.now();

const subprocess = execa('scrcpy', args, {
  stdin: 'ignore',
  buffer: false,
  reject: false,
  windowsHide: false, // flip to true to compare
});

subprocess.stderr.on('data', (chunk) => {
  process.stdout.write(`[+${((Date.now() - start) / 1000).toFixed(1)}s] ${chunk}`);
});

subprocess.then((result) => {
  console.log('--- END ---');
  console.log('total duration (s):', ((Date.now() - start) / 1000).toFixed(1));
  console.log('exitCode:', result.exitCode, 'signal:', result.signal);
});

process.on('SIGINT', () => {
  console.log('Ctrl+C received, stopping voluntarily.');
  subprocess.kill('SIGTERM');
});
