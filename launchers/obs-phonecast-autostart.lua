--[[
  obs-phonecast: automatic dock launcher, with self-install.

  Add via OBS: Tools > Scripts > + (bottom left) > select this file.
  Lua only, nothing extra to install -- OBS bundles its own Lua
  interpreter, unlike the Python scripting path which needs a separate
  Python install pointed to from Tools > Scripts > Python Settings.

  What it does: starts `obs-phonecast --dock` in the background when the
  script loads (OBS startup, or the moment you add the script), and stops
  it again when OBS closes or the script is removed. If obs-phonecast
  isn't installed yet, it runs `npm install -g obs-phonecast` itself in
  the background and starts the dock automatically once that finishes --
  no command to type by hand. You still add the dock itself once, by
  hand: Docks > Custom Browser Docks, using the URL this script's log
  prints (Tools > Scripts, bottom "Script log" panel).

  REQUIRES Node.js/npm to already be installed on this machine. This
  script does not install Node itself -- only obs-phonecast, which is an
  npm package. If npm itself can't be found, the install attempt fails
  and says so in the log; installing Node.js from nodejs.org first is a
  separate, one-time step this script can't do for you.

  HONEST STATUS: written by reasoning about OBS's Lua scripting API and
  each OS's shell, not verified against a real OBS instance -- this
  project had no OBS install available while building it. The Windows
  path in particular (PowerShell quoted through io.popen) is the part
  most likely to need a fix, and has already needed several rounds of
  fixes for real, reported failures. If it doesn't work, open
  Tools > Scripts, select this script, and copy whatever the "Script log"
  button at the bottom shows -- every meaningful step logs through
  obs.script_log() below, and will say which one failed.
]]

obs = obslua

local dock_pid = nil
local auto_start = true
local dock_port = 7412
local install_attempts = 0
local MAX_INSTALL_POLLS = 20 -- ~60s at 3s intervals, then give up

local function is_windows()
  -- The standard Lua idiom for this: package.config's first character is
  -- the OS path separator, "\\" on Windows and "/" everywhere else.
  return package.config:sub(1, 1) == "\\"
end

local function file_exists(path)
  local f = io.open(path, "r")
  if f ~= nil then
    f:close()
    return true
  end
  return false
end

--[[
  Where obs-phonecast would be if it's installed, and whether it's
  actually there right now.

  Windows: %APPDATA%\npm\obs-phonecast.cmd is where a global npm install
  places its shim by default. Checked directly rather than relying on
  PATH, because of a real failure hit in practice: a process already
  running when `npm install -g` updated the User PATH (OBS itself, or the
  Explorer process that launched it) never picks up that change until
  it's restarted, so a bare PATH-based lookup can fail even right after a
  successful install.

  Non-Windows: no equivalent fixed location (varies by how Node itself
  was installed -- nvm, Homebrew, the system package manager, all differ),
  so this checks PATH directly via `command -v`, which is the standard
  POSIX way to ask "would running this name actually find something."
]]
local function resolve_exe_path()
  if is_windows() then
    local appdata = os.getenv("APPDATA")
    if appdata == nil then
      return nil, nil
    end
    local candidate = appdata .. "\\npm\\obs-phonecast.cmd"
    if file_exists(candidate) then
      return candidate, candidate
    end
    return nil, candidate
  else
    local found = os.execute("command -v obs-phonecast > /dev/null 2>&1")
    if found then
      return "obs-phonecast", nil
    end
    return nil, nil
  end
end

local function start_dock() end -- forward declaration; defined below

--[[
  Installs obs-phonecast via npm, detached (does not block OBS while it
  runs). Mirrors the same "spawn detached, don't wait" approach used for
  the dock itself.

  Windows: routed through cmd.exe /c for the same reason obs-phonecast
  itself needed it -- npm is ALSO typically a .cmd shim (npm.cmd), not a
  raw .exe, so Start-Process can't resolve it directly either.
]]
local function npm_install_detached()
  local temp_dir = os.getenv("TEMP") or os.getenv("TMP") or (is_windows() and "." or "/tmp")
  local sep = is_windows() and "\\" or "/"
  local install_log = temp_dir .. sep .. "obs-phonecast-npm-install.log"

  if is_windows() then
    local script_path = temp_dir .. "\\obs-phonecast-install.ps1"
    local ps_file = io.open(script_path, "w")
    if ps_file == nil then
      obs.script_log(obs.LOG_WARNING, "obs-phonecast: could not write install script at " .. script_path)
      return false, install_log
    end
    ps_file:write(
      "$p = Start-Process -FilePath 'cmd.exe' " ..
        "-ArgumentList '/c','npm','install','-g','obs-phonecast' " ..
        "-WindowStyle Hidden -PassThru " ..
        "-RedirectStandardOutput '" .. install_log .. "' " ..
        "-RedirectStandardError '" .. install_log .. "'\n" ..
      "$p.Id\n"
    )
    ps_file:close()

    local handle = io.popen(
      'powershell -NoProfile -ExecutionPolicy Bypass -File "' .. script_path .. '" 2>&1'
    )
    if handle == nil then
      return false, install_log
    end
    local output = handle:read("*l")
    handle:close()
    return output ~= nil, install_log
  else
    local handle = io.popen(
      "npm install -g obs-phonecast > " .. install_log .. " 2>&1 &"
    )
    if handle == nil then
      return false, install_log
    end
    handle:close()
    return true, install_log
  end
end

--[[
  Polls every few seconds for obs-phonecast to become resolvable, and
  starts the dock automatically the moment it is -- so "self-install" is
  actually hands-off, not just "the install runs, then you click a
  button." Gives up after MAX_INSTALL_POLLS with a clear pointer to the
  install log, rather than polling forever if npm itself failed (no
  internet, broken npm, no Node.js installed at all).
]]
local function poll_for_install()
  install_attempts = 0
  local function check()
    install_attempts = install_attempts + 1
    local exe_path = resolve_exe_path()
    if exe_path ~= nil then
      obs.remove_current_callback()
      obs.script_log(obs.LOG_INFO, "obs-phonecast: install finished, starting the dock now.")
      start_dock()
      return
    end
    if install_attempts >= MAX_INSTALL_POLLS then
      obs.remove_current_callback()
      obs.script_log(
        obs.LOG_WARNING,
        "obs-phonecast: still not found after waiting for the install to finish. " ..
          "Check the install log mentioned above, or install manually: npm install -g obs-phonecast"
      )
    end
  end
  obs.timer_add(check, 3000)
end

--[[
  Spawns the dock in the background and captures its PID, so it can be
  stopped cleanly later instead of left running after OBS closes.

  If obs-phonecast isn't found at all, this kicks off a background
  install and returns without launching anything this round --
  poll_for_install() takes over and calls this function again once the
  install completes.

  UNTESTED end-to-end on a real OBS install -- see the file header.
]]
start_dock = function()
  if dock_pid ~= nil then
    return
  end

  local exe_path, windows_candidate = resolve_exe_path()

  if exe_path == nil then
    obs.script_log(
      obs.LOG_INFO,
      "obs-phonecast: not found" ..
        (windows_candidate and (" at " .. windows_candidate) or "") ..
        ". Installing it now via npm in the background (this can take under a minute; " ..
        "requires Node.js/npm to already be installed)..."
    )
    local started, install_log = npm_install_detached()
    if not started then
      obs.script_log(
        obs.LOG_WARNING,
        "obs-phonecast: could not start the automatic install. Install it manually: " ..
          "npm install -g obs-phonecast (requires Node.js: https://nodejs.org)"
      )
      return
    end
    obs.script_log(obs.LOG_INFO, "obs-phonecast: install running, log at " .. tostring(install_log))
    poll_for_install()
    return
  end

  local port = tostring(dock_port or 7412)
  local handle
  local log_path

  if is_windows() then
    -- Writing the PowerShell body to a temp .ps1 FILE, rather than
    -- inlining it as a quoted -Command string, avoids cmd.exe (which
    -- io.popen shells out through on Windows) re-parsing the whole line,
    -- where single quotes inside a double-quoted -Command string are
    -- exactly the kind of nesting that silently breaks.
    -- -ExecutionPolicy Bypass applies only to this one invocation, not
    -- the system-wide policy, and is needed because running a .ps1 FILE
    -- (unlike -Command) is subject to execution policy restrictions that
    -- are commonly set to block scripts by default.
    local temp_dir = os.getenv("TEMP") or os.getenv("TMP") or "."
    local script_path = temp_dir .. "\\obs-phonecast-start.ps1"
    local ps_file = io.open(script_path, "w")
    if ps_file == nil then
      obs.script_log(obs.LOG_WARNING, "obs-phonecast: could not write temp script at " .. script_path)
      return
    end

    -- Start-Process -FilePath 'obs-phonecast' directly does NOT work:
    -- a globally npm-installed CLI on Windows is a .cmd shim (it wraps a
    -- call to node), not a real .exe, and Start-Process's own file lookup
    -- doesn't resolve shim scripts the way typing the command in a shell
    -- does -- confirmed in practice ("Start-Process : ... Le fichier
    -- spécifié est introuvable" is exactly that failure). Routing through
    -- cmd.exe /c fixes it: cmd.exe's own command lookup DOES resolve
    -- .cmd shims, whether given a bare name via PATH or a direct path.
    -- taskkill's existing "/T" in stop_dock() (tree-kill) is what makes
    -- this safe to stop later: the PID captured here is cmd.exe's own,
    -- with the actual node process as its child, and /T kills both.
    --
    -- Output capture: Start-Process's PID is cmd.exe's own, which
    -- launches successfully even if the command INSIDE it fails right
    -- after. -RedirectStandardOutput/-RedirectStandardError are
    -- Start-Process's OWN native parameters, handled entirely by
    -- PowerShell -- not text embedded inside the ArgumentList string.
    -- Two separate files, since Start-Process errors if both streams
    -- target the same one.
    --
    -- exe_path is passed as its OWN array element (not concatenated into
    -- a bigger string) specifically so a space in the resolved path
    -- (e.g. "C:\Users\Jean Dupont\...") gets quoted correctly by
    -- PowerShell/.NET's own argument handling, rather than needing this
    -- script to hand-write nested quotes around it.
    local out_log = temp_dir .. "\\obs-phonecast-dock-out.log"
    local err_log = temp_dir .. "\\obs-phonecast-dock-err.log"
    log_path = err_log
    ps_file:write(
      "$p = Start-Process -FilePath 'cmd.exe' " ..
        "-ArgumentList '/c','" .. exe_path .. "','--dock','--dock-port','" .. port .. "','--no-open' " ..
        "-WindowStyle Hidden -PassThru " ..
        "-RedirectStandardOutput '" .. out_log .. "' " ..
        "-RedirectStandardError '" .. err_log .. "'\n" ..
      "$p.Id\n"
    )
    ps_file:close()

    -- 2>&1: if PowerShell itself errors (a bad path, a missing command),
    -- that error now lands in the same output we already parse, instead
    -- of vanishing into an unread stderr and showing up as an unhelpful
    -- "produced no output."
    handle = io.popen(
      'powershell -NoProfile -ExecutionPolicy Bypass -File "' .. script_path .. '" 2>&1'
    )
  else
    -- "&" backgrounds the process under /bin/sh; "$!" is its PID. Output
    -- is redirected so nothing tries to write to a terminal that isn't
    -- there.
    log_path = "/tmp/obs-phonecast-dock.log"
    handle = io.popen(
      exe_path .. " --dock --dock-port " .. port .. " --no-open " ..
      "> " .. log_path .. " 2>&1 & echo $!"
    )
  end

  if handle == nil then
    obs.script_log(obs.LOG_WARNING, "obs-phonecast: could not spawn the dock (io.popen returned nil).")
    return
  end

  local output = handle:read("*l")
  handle:close()

  if output == nil then
    obs.script_log(obs.LOG_WARNING, "obs-phonecast: dock spawn produced no output; PID unknown.")
    return
  end

  local pid = output:match("%d+")
  if pid == nil then
    obs.script_log(
      obs.LOG_WARNING,
      "obs-phonecast: could not parse a PID from: " .. tostring(output) ..
        ". The dock may still be running, but won't be stopped automatically."
    )
    return
  end

  dock_pid = pid
  obs.script_log(
    obs.LOG_INFO,
    "obs-phonecast: dock started (pid " .. dock_pid .. "). Add it in OBS via " ..
      "Docks > Custom Browser Docks, URL: http://127.0.0.1:" .. port ..
      ". If that URL doesn't respond, obs-phonecast's own output is in " ..
      tostring(log_path) .. "."
  )
end

local function stop_dock()
  if dock_pid == nil then
    return
  end

  if is_windows() then
    os.execute('taskkill /PID ' .. dock_pid .. ' /T > NUL 2>&1')
  else
    os.execute('kill ' .. dock_pid .. ' > /dev/null 2>&1')
  end

  obs.script_log(obs.LOG_INFO, "obs-phonecast: dock stopped (pid " .. dock_pid .. ").")
  dock_pid = nil
end

function script_description()
  return "Starts the obs-phonecast dock automatically when OBS launches, " ..
         "installing obs-phonecast itself via npm first if it isn't found " ..
         "(requires Node.js/npm to already be installed). Stops the dock " ..
         "when OBS closes.\n\n" ..
         "Add the dock itself once, by hand: Docks > Custom Browser Docks, " ..
         "using the URL printed below in this script's log."
end

function script_properties()
  local props = obs.obs_properties_create()
  obs.obs_properties_add_bool(props, "auto_start", "Start the dock automatically")
  obs.obs_properties_add_int(props, "dock_port", "Dock port", 1024, 65535, 1)
  obs.obs_properties_add_button(props, "restart_button", "Restart dock now", restart_button_clicked)
  return props
end

function script_defaults(settings)
  obs.obs_data_set_default_bool(settings, "auto_start", true)
  obs.obs_data_set_default_int(settings, "dock_port", 7412)
end

function script_update(settings)
  local was_auto_start = auto_start
  auto_start = obs.obs_data_get_bool(settings, "auto_start")
  dock_port = obs.obs_data_get_int(settings, "dock_port")

  if auto_start and not was_auto_start and dock_pid == nil then
    start_dock()
  elseif not auto_start and dock_pid ~= nil then
    stop_dock()
  end
end

function restart_button_clicked(props, prop)
  stop_dock()
  start_dock()
  return false
end

function script_load(settings)
  script_update(settings)
  if auto_start then
    start_dock()
  end
end

function script_unload()
  stop_dock()
end