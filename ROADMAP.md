# Roadmap

## Deliberately deferred

### Automatic detection of the OBS password
OBS stores its WebSocket settings in
`%APPDATA%\obs-studio\plugin_config\obs-websocket\` (equivalents on macOS
and Linux), password included in plain text. Reading it on first launch
would remove the manual entry step entirely for a local OBS.

Caveats:
- undocumented internal file, the format could change > auto-detect with a
  fallback to manual entry, never the only path
- only works if OBS runs on the same machine
- exact file name and key still need confirming, not yet verified

### First-run wizard -- done
Implemented as `--init` (`src/init.js`, `src/prompt.js`). Prompts for the OBS
WebSocket password (masked, on a real TTY) and a default app, writes the
config file, refuses to overwrite an existing one unless `--force` is passed.

**A real bug hit while building it, worth remembering**: awaiting between
two sequential `readline` `.question()` calls on a *piped, non-TTY* stdin
can hang forever. If the piped input reaches EOF in the gap between the
two `await`s, the underlying stream's `'end'` event fires, and `readline`
silently stops servicing further questions on that interface -- even with
a single shared interface, and even though `.close()` was never called.
Confirmed in isolation, independent of this project's code: two
back-to-back `await new Promise((r) => rl.question(...))` calls hang,
while the same two `.question()` calls nested as synchronous callbacks
(no `await` in between) work fine. Fix used here: when stdin isn't a TTY,
skip `readline` entirely for that path, read all of stdin eagerly up
front, and hand out one line per question from that buffer instead. A
real interactive terminal never hits this, since input arrives live as
someone types rather than all at once before EOF -- but anything that
might be tested or run non-interactively (piped answers, CI, scripts)
can.

Automatic OBS-password detection (below) remains a possible follow-up to
make this wizard need even fewer questions, not a blocker for it.

### OBS browser dock -- done
Implemented (`src/server/`, `web/index.html`). A local HTTP + WebSocket
server serves a single-page control panel: app picker, on-air-style
start/stop, live log feed, and a settings panel that reads and writes the
same config file `--init` produces. Added to OBS via Docks → Custom
Browser Docks, exactly as planned below.

**Security decisions made while building it, worth keeping intact if this
code is touched:**

1. **Binds to `127.0.0.1` by default, not `0.0.0.0`.** `server.listen(port)`
   with no host argument binds to every network interface. Since this
   server can read AND overwrite the OBS WebSocket password (through
   `getConfig`/`saveConfig`) and start/stop a live session, that default
   would expose all of it to anyone on the same network. `--dock-host`
   exists for someone who genuinely wants to drive the dock from another
   device on their LAN, but it's an explicit, logged opt-in, never silent.

2. **WebSocket connections are checked against their `Origin` header**
   (`isAllowedOrigin` in `src/server/index.js`). A WebSocket handshake,
   unlike a `fetch()`, is not subject to the same-origin policy by
   default -- any webpage open in a normal browser on the same machine
   (a malicious ad, a compromised tab) could otherwise open a connection
   to a localhost server and issue commands through it. This is a known
   vulnerability class for local dev servers and Electron-style local
   control panels. Requests with no `Origin` header (a raw `ws` client,
   this project's own tests) are still allowed, since there's no reliable
   way to authenticate those differently -- the real protection this adds
   is specifically against a third-party webpage, not against another
   local process already running on the machine, which no unauthenticated
   local tool fully defends against.

3. **A real bug caught by its own test, worth remembering**: `URL(...).hostname`
   brackets an IPv6 literal (`"[::1]"`), but the raw `--dock-host` value
   and Node's `server.listen(port, host)` use the bare form (`"::1"`).
   Using one hardcoded set for both broke IPv6 loopback origin-matching
   the first time it was tested. Fixed by normalizing the parsed
   hostname (stripping the brackets) before comparing against a single
   bare-form set, rather than maintaining two similar-looking sets for
   what look like the same value but aren't.

Not solved, and worth being honest about: none of this defends against
another process already running on the same machine with equivalent
privileges (malware, or another user session on a shared machine) --
that's a general OS-level boundary no local, unauthenticated tool fully
closes. If that threat model matters to you, don't run the dock at all;
use the CLI directly.

Still open: changing the running app without restarting scrcpy (the
`adb shell am start --display <id>` mechanism), and exposing more of the
config surface in the settings panel than the five fields currently
shown.

### Android 11+ wireless pairing
Six-digit code, variable mDNS port (`adb pair host:port code`). The current
`adb tcpip` mode is enough for the prototype.

### Native OBS plugin -- ruled out
No password needed (direct access to the OBS API), but C++, a build for
three OSes, and ABI compatibility to retest on every major OBS release.
Prohibitive cost for a solo maintainer. Plugins far more established than
this one die from exactly that.

### OBS's `--websocket_password` option
OBS accepts `--websocket_port` and `--websocket_password` at launch to
override its config. Useful for a portable mode with a provided shortcut,
but requires editing the user's shortcut > an advanced option, not a
default.

## Resolved: the intermittent virtual-display disconnect

Long debugging session, several false leads before finding the real cause.
Recorded here in full so nobody re-chases the same dead ends.

**Symptom**: with `--app <name>` in virtual-display mode, obs-phonecast would
sometimes fall back to mirror mode after roughly 10-20 seconds, with the
OBS source stuck at 0x0 (no frame received). The exact same scrcpy command,
run by hand with OBS capturing the same way, never showed this problem.

**Leads investigated and ruled out, in order:**

1. **scrcpy issue #6787** (virtual display blanks 10s after the physical
   screen turns off). `--keep-active` is the documented workaround; kept
   enabled by default since it's cheap and legitimate for its actual
   purpose, but confirmed NOT to explain this particular symptom.

2. **Extending the phone's screen-off timeout.** Implemented as a second
   attempt at the same theory. Confirmed unnecessary: a manual `scrcpy`
   run, with the timeout already disabled by hand and the physical screen
   staying on the whole time, still didn't reproduce the issue -- while
   obs-phonecast, under the same conditions, still could. Kept in the code,
   OFF by default, as a low-cost precaution for other devices; no longer
   presented as a fix for this symptom. Also turned up a real, unrelated
   bug in passing: on ColorOS, `adb shell` doesn't have the
   `WRITE_SETTINGS` permission, and the write was throwing an uncaught
   `SecurityException` that crashed startup entirely -- fixed to fail
   silently (a warning) instead.

3. **`windowsHide: true` in the execa spawn options.** Hypothesis: hiding
   the child's console window somehow affected the SDL window's behavior.
   Reverted to `false` to test. Ruled out by a dedicated isolated repro
   script (`scripts/diag-spawn.js`) that spawns the exact same command via
   execa, with no orchestrator, no OBS, and no adb layer around it: it
   never disconnected, with `windowsHide` either way. This definitively
   ruled out the spawn mechanics themselves (execa, Node, `windowsHide`)
   as the cause.

4. **An uncaught `error` event on the OBS WebSocket connection.**
   `obs-websocket-js` exposes its client as a plain Node `EventEmitter`. An
   `error` event with no listener attached is treated by Node as an
   unhandled exception, which crashes the whole process -- and our own
   cleanup on `process.on('exit')` would then kill scrcpy, believing it
   was cleaning up after a normal exit, with zero error output on the
   scrcpy side. This was a REAL bug, fixed by attaching a listener before
   the first connection attempt (see `src/obs/client.js`), plus a global
   `uncaughtException` / `unhandledRejection` safety net in `index.js`.
   However: fixing it did not, by itself, make the disconnects stop. It
   was a real bug worth fixing regardless, just not *the* explanation for
   this specific symptom.

5. **The actual root cause**, found via Process Monitor: nothing external
   was killing scrcpy at all. The `Exit Status: 1` in Process Monitor's
   log was our OWN orchestrator, deliberately stopping the scrcpy process
   after `waitForSourceSize` timed out (15s) with the OBS source still at
   0x0. The real question was never "what's killing scrcpy" -- it was
   "why does OBS never receive a frame". And the answer to that turned out
   to be simple: **on the very first launch, when the OBS scene and source
   don't exist yet, OBS takes noticeably longer to make the capture
   window's properties available than it does once both already exist.**
   The 15-second timeout, tuned for the "already exists" case, wasn't
   enough for the "just created" case.

**The actual fix** (`src/obs/scene.js`, `setupScene`): detect whether the
scene or the source was just created, and if so, extend the window-search
and frame-wait timeouts by 10 extra seconds for that run only. Subsequent
launches, once the scene and source already exist, keep the original,
faster timeout.

**A separate, smaller finding along the way**: the Windows capture method
had briefly been changed from forced WGC (`method: 2`) to Automatic
(`method: 0`) in an attempt to avoid a hypothetical silent 0x0 if WGC
wasn't available. In practice, on a Direct3D11-rendered window (scrcpy's
common case), Automatic can resolve to the legacy BitBlt method instead,
which fails silently on D3D11 flip-model swapchains -- producing exactly
the 0x0 symptom it was meant to prevent. Reverted to forced WGC as the
default, with `--capture-method` / `windowCaptureMethod` available as an
escape hatch for environments where WGC isn't usable (older Windows, some
VMs, remote GPUs). This was a real, separate 0x0 cause on at least one
run, distinct from the timing issue above -- both needed fixing.

**Lesson for future debugging in this codebase**: when scrcpy exits
mid-session with no error output, check who actually killed it before
assuming an external cause (antivirus, GPU driver crash, OS scheduler).
`Exit Status: 1` with low CPU/kernel time and a lifetime matching one of
our own timeout values (15s, 20s...) is a strong signal it's our own
fallback logic, not something external.

## Still to verify on real hardware

- exact cursor-related key for `window_capture` on Windows (`cursor` vs
  `capture_cursor`) -- both are set defensively, unclear which one (if
  either) the installed OBS version actually reads
- name and structure of the modern macOS source (`screen_capture` +
  `type: 1`) -- never tested on real macOS hardware
- real nav-bar heights across navigation modes and manufacturers (current
  defaults are reasonable estimates, not measured)
- behavior of `taskkill /T` without `/F` in `--v4l2-sink` mode (no window,
  so no message loop: expected to always escalate to `/F`) -- reasoned
  about, not observed, and only relevant on Linux where v4l2 applies while
  taskkill is Windows-only, so this specific combination can't actually
  occur; worth double-checking the equivalent SIGTERM path on Linux
  instead

## Before publishing

- [ ] packaging (`bun build --compile` or Node SEA)
- [ ] code signing -- Gatekeeper blocks without a Developer ID, SmartScreen
      warns without reputation

## Code signing -- unresolved

The one issue neither Node nor Go solves. Binaries produced by the release
workflow aren't signed:

- **Windows**: SmartScreen warns until the binary builds up reputation. An
  EV certificate removes the warning immediately, ~$300-400/year.
- **macOS**: Gatekeeper **blocks** outright, not just a warning. Requires a
  Developer ID ($99/year) and notarization. Without it, the user has to go
  through System Settings or `xattr -d com.apple.quarantine`.
- **Linux**: no issue at all.

Free workaround: also publish to npm. `npx obs-phonecast` sidesteps both
mechanisms entirely, at the cost of requiring Node on the user's machine.
Probably the right early compromise -- signed binaries can wait until the
project has actual users.
