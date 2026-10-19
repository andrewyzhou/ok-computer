#!/usr/bin/env bash
# this script controls the agent from any terminal on macos and linux.
# commands: start, stop, restart, status, open, logs, browser login [url], install, uninstall.
# it runs on the bash 3.2 of macos, so it uses no mapfile, no case changes in expansions and no associative arrays.
set -euo pipefail

# okc install links ~/.local/bin/okc to this script, so the root comes from the script itself and not from the link.
# the readlink of older macos has no -f, so the loop follows each link by hand.
script="${BASH_SOURCE[0]}"
while [[ -L "$script" ]]; do
  link="$(readlink "$script")"
  if [[ "$link" == /* ]]; then script="$link"; else script="$(dirname "$script")/$link"; fi
done
root="$(cd "$(dirname "$script")/.." && pwd)"
data="$root/data"
# the tests give their own address, because a real agent can listen on the default port of the same machine.
url="${OKC_URL:-http://127.0.0.1:4317}"
label='com.okcomputer.agent'
pid_file="$data/okc.node.pid"
stamp="$root/dist/.build-ok"
plist="$HOME/Library/LaunchAgents/$label.plist"
template="$root/scripts/macos/$label.plist"
# the name does not start with okc-, because okc logs shows the newest okc-*.log file.
launcher_log="$data/logs/launcher.log"

# the agent that agent_pid found, and where it found it: launchd or the pid file.
agent=''
agent_source=''

fail() {
  echo "error: $1"
  exit 1
}

# the tests replace uname to try the macos paths on linux.
is_darwin() {
  [[ "$(uname -s)" == 'Darwin' ]]
}

has() {
  command -v "$1" >/dev/null 2>&1
}

domain() {
  echo "gui/$(id -u)"
}

# launchd manages the agent when okc install wrote the login agent. this works only on macos.
launchd_managed() {
  is_darwin && [[ -f "$plist" ]]
}

# launchctl print fails when the login agent is not loaded.
launchd_print() {
  launchd_managed && launchctl print "$(domain)/$label" 2>/dev/null
}

launchd_loaded() {
  launchd_print >/dev/null
}

# a pid file stays after a crash, a logoff or a reboot, and the system then gives its id to other processes. so a
# process counts only when its command line runs the agent of this root.
pid_matches() {
  local command
  command="$(LC_ALL=C ps -ww -p "$1" -o command= 2>/dev/null)" || return 1
  [[ "$command" == *"$root/dist/main.js"* ]]
}

# this sets agent and agent_source, or leaves both empty when no agent of this root runs. a pid file that does not
# match is deleted.
agent_pid() {
  agent=''
  agent_source=''
  local output line text re='^[[:space:]]*pid = ([0-9]+)'
  if output="$(launchd_print)"; then
    while IFS= read -r line; do
      if [[ "$line" =~ $re ]]; then
        if pid_matches "${BASH_REMATCH[1]}"; then
          agent="${BASH_REMATCH[1]}"
          agent_source='launchd'
          return 0
        fi
        break
      fi
    done <<<"$output"
  fi
  [[ -f "$pid_file" ]] || return 1
  text="$(tr -d '[:space:]' <"$pid_file")"
  if [[ "$text" =~ ^[0-9]+$ ]] && pid_matches "$text"; then
    agent="$text"
    agent_source='file'
    return 0
  fi
  rm -f "$pid_file"
  return 1
}

# the agent writes its stop token to the data folder of its config. the live folder points that at the data folder of
# the repository, while the pid file and the launcher log stay in the data folder of this root. this sets agent_data.
agent_data_path() {
  agent_data="$data"
  local config="$root/okc.config.json" found
  [[ -f "$config" ]] || return 0
  local script='
    const [root, file] = process.argv.slice(1);
    let config;
    try { config = JSON.parse(require("node:fs").readFileSync(file, "utf8")); } catch { process.exit(2); }
    const configured = config && config.paths && config.paths.data;
    if (typeof configured === "string" && configured) console.log(require("node:path").resolve(root, configured));'
  if found="$(node -e "$script" "$root" "$config" 2>/dev/null)"; then
    if [[ -n "$found" ]]; then agent_data="$found"; fi
  else
    echo "okc.config.json is not valid json, so the stop token is read from $data."
  fi
}

# the build writes dist/.build-ok as its last step, so a failed build leaves no stamp. folders count too, because a
# deleted or renamed file changes only the time of its folder.
build_is_old() {
  [[ -f "$stamp" ]] || return 0
  local inputs=() name
  for name in src web/src package.json package-lock.json tsconfig.json tsconfig.build.json web/index.html \
    web/vite.config.ts web/tsconfig.json; do
    if [[ -e "$root/$name" ]]; then inputs+=("$root/$name"); fi
  done
  [[ ${#inputs[@]} -gt 0 ]] || return 1
  [[ -n "$(find "${inputs[@]}" -newer "$stamp" -print -quit 2>/dev/null)" ]]
}

run_build() {
  echo 'building...'
  local output
  if ! output="$(cd "$root" && npm run build --silent 2>&1)"; then
    printf '%s\n' "$output" | tail -n 40
    fail 'the build failed.'
  fi
}

# the agent keeps the code of its start, also when a later build replaced the files. ps gives the start in whole
# seconds, so the stamp counts as newer only from the next second on.
code_is_newer() {
  build_is_old && return 0
  local started
  started="$(LC_ALL=C ps -p "$1" -o lstart= 2>/dev/null)" || return 1
  node -e '
    const [started, stamp] = process.argv.slice(1);
    const built = Math.floor(require("node:fs").statSync(stamp).mtimeMs / 1000) * 1000;
    process.exit(built > Date.parse(started) ? 0 : 1);' "$started" "$stamp"
}

find_node() {
  has node || fail 'node is not on the path.'
  command -v node
}

start_agent() {
  local open=1 arg
  for arg in "$@"; do
    if [[ "$arg" == '--no-open' ]]; then open=0; fi
  done
  if agent_pid; then
    echo 'ok computer is already running.'
    if code_is_newer "$agent"; then
      echo 'the code on disk is newer than the running agent. run okc restart to load it.'
    fi
  else
    if build_is_old; then run_build; fi
    if launchd_managed; then
      if launchd_loaded; then
        launchctl kickstart "$(domain)/$label"
      else
        launchctl bootstrap "$(domain)" "$plist"
      fi
    else
      local node
      node="$(find_node)"
      mkdir -p "$data/logs"
      (cd "$root" && exec nohup "$node" "$root/dist/main.js" </dev/null >>"$launcher_log" 2>&1) &
      echo "$!" >"$pid_file"
    fi
    echo 'ok computer started.'
  fi
  if [[ $open -eq 1 ]]; then open_dashboard; fi
}

# a zombie or a process that took the pid does not run the agent, so it does not count as alive.
wait_for_exit() {
  local pid="$1" tries=$(($2 * 5))
  while ((tries > 0)); do
    pid_matches "$pid" || return 0
    sleep 0.2
    tries=$((tries - 1))
  done
  ! pid_matches "$pid"
}

stop_agent() {
  if ! agent_pid; then
    rm -f "$pid_file"
    echo 'ok computer is not running.'
    return 0
  fi
  local pid="$agent" source="$agent_source"
  # a forced stop skips the end of the runs, so the agent first gets 10 seconds to stop by itself.
  agent_data_path
  local token_file="$agent_data/okc.stop-token"
  if [[ -f "$token_file" ]]; then
    if has curl; then
      local token
      token="$(tr -d '[:space:]' <"$token_file")"
      token="${token//\\/\\\\}"
      token="${token//\"/\\\"}"
      # the body goes through stdin, because ps shows the command line of curl to every user.
      printf '{"token":"%s"}' "$token" |
        curl -s -o /dev/null -m 5 -X POST -H 'content-type: application/json' --data-binary @- "$url/api/shutdown" ||
        true
      wait_for_exit "$pid" 10 || true
    else
      echo 'curl is not installed, so okc cannot ask the agent to stop.'
    fi
  fi
  if pid_matches "$pid"; then
    echo 'the agent did not stop by itself, so okc stops it.'
    if [[ "$source" == 'launchd' ]]; then
      # launchd starts the agent again after a kill, but not after a bootout.
      launchctl bootout "$(domain)/$label" || true
    else
      kill -TERM "$pid" 2>/dev/null || true
      if ! wait_for_exit "$pid" 5; then kill -KILL "$pid" 2>/dev/null || true; fi
    fi
  fi
  rm -f "$pid_file"
  echo 'ok computer stopped.'
}

# this prints the http code of the overview, or 000 when nothing answers.
overview_code() {
  curl -s -o /dev/null -w '%{http_code}' -m 2 "$url/api/overview" 2>/dev/null || true
}

open_dashboard() {
  # the dashboard needs a few seconds after a start.
  if has curl; then
    local i code
    for ((i = 0; i < 30; i++)); do
      code="$(overview_code)"
      if [[ -n "$code" && "$code" != '000' ]]; then break; fi
      sleep 1
    done
  else
    echo 'curl is not installed, so okc does not wait for the dashboard.'
  fi
  if is_darwin; then
    open "$url"
  elif has xdg-open; then
    xdg-open "$url" >/dev/null 2>&1 || true
  else
    echo "open $url in a browser."
  fi
}

show_status() {
  if agent_pid; then echo "running (pid $agent)"; else echo 'not running'; fi
  if has curl; then
    # a dashboard token makes the overview answer 401, and that still means the agent is up.
    local code
    code="$(overview_code)"
    if [[ -n "$code" && "$code" != '000' ]]; then echo "dashboard: $url"; else echo 'dashboard: not reachable'; fi
  else
    echo 'dashboard: not reachable (curl is not installed)'
  fi
  local errors="$data/logs/launchd.err.log"
  if [[ -s "$errors" ]]; then
    echo 'last errors:'
    tail -n 3 "$errors"
  fi
}

show_logs() {
  local latest='' file
  for file in "$data"/logs/okc-*.log; do
    [[ -f "$file" ]] || continue
    if [[ -z "$latest" || "$file" -nt "$latest" ]]; then latest="$file"; fi
  done
  if [[ -n "$latest" ]]; then tail -n 40 -f "$latest"; else echo 'no logs yet.'; fi
}

# the owner signs in to sites in the agent's own chrome profile. the window is plain chrome, and the agent cannot use
# the profile while it is open.
browser_login() {
  if [[ "${1:-}" != 'login' ]]; then
    echo 'usage: okc browser login [url]'
    return 0
  fi
  # a build replaces the files of a running agent, and its dashboard then serves a page that is newer than its api.
  if ! agent_pid && build_is_old; then run_build; fi
  if [[ -n "${2:-}" ]]; then
    (cd "$root" && node dist/browser/login.js "$2")
  else
    (cd "$root" && node dist/browser/login.js)
  fi
}

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# the template is filled with sed, so a value must not end the replacement or refer to the match.
sed_escape() {
  printf '%s' "$1" | sed -e 's/[\\|&]/\\&/g'
}

fill() {
  sed_escape "$(xml_escape "$1")"
}

link_command() {
  mkdir -p "$HOME/.local/bin"
  ln -sfn "$root/scripts/okc.sh" "$HOME/.local/bin/okc"
}

install_agent() {
  if ! is_darwin; then
    link_command
    echo 'installed: okc command. linux has no login agent yet, so run okc start after you sign in.'
    return 0
  fi
  # a second agent cannot hold the data folder next to the one that launchd starts.
  if agent_pid && [[ "$agent_source" == 'file' ]]; then stop_agent; fi
  # launchd starts dist/main.js at once, because of RunAtLoad.
  if build_is_old; then run_build; fi
  link_command
  local node logs path
  node="$(find_node)"
  logs="$data/logs"
  mkdir -p "$logs" "$(dirname "$plist")"
  path="$(dirname "$node"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  sed -e "s|@@NODE@@|$(fill "$node")|g" -e "s|@@ROOT@@|$(fill "$root")|g" -e "s|@@PATH@@|$(fill "$path")|g" \
    -e "s|@@LOGS@@|$(fill "$logs")|g" "$template" >"$plist"
  if has plutil; then plutil -lint "$plist" >/dev/null || fail "the login agent at $plist is not a valid plist."; fi
  if launchd_loaded; then launchctl bootout "$(domain)/$label" || true; fi
  launchctl bootstrap "$(domain)" "$plist"
  echo "installed: okc command and the $label login agent."
}

uninstall_agent() {
  stop_agent
  if launchd_loaded; then launchctl bootout "$(domain)/$label" || true; fi
  rm -f "$plist"
  local command="$HOME/.local/bin/okc"
  if [[ -L "$command" && "$(readlink "$command")" == "$root/scripts/okc.sh" ]]; then rm -f "$command"; fi
  echo 'uninstalled.'
}

main() {
  local command="${1:-start}"
  case "$command" in
    start) start_agent "${@:2}" ;;
    stop) stop_agent ;;
    restart)
      stop_agent
      start_agent "${@:2}"
      ;;
    status) show_status ;;
    open) open_dashboard ;;
    logs) show_logs ;;
    browser) browser_login "${@:2}" ;;
    install) install_agent ;;
    uninstall) uninstall_agent ;;
    *) echo 'usage: okc [start|stop|restart|status|open|logs|browser login [url]|install|uninstall] [--no-open]' ;;
  esac
}

# launchd and a login shell run this script without a terminal, so the launcher log keeps what a start or a stop shows.
# a log over 1 mb starts again.
logged_main() {
  mkdir -p "$data/logs"
  if [[ -f "$launcher_log" ]] && (($(wc -c <"$launcher_log") > 1048576)); then rm -f "$launcher_log"; fi
  # bash ignores set -e in the whole of a command after || or &&, so the status comes from a plain pipeline, and the
  # subshell turns set -e on again.
  local status
  set +e
  (
    set -e
    main "$@"
  ) 2>&1 | tee -a "$launcher_log"
  status=$?
  set -e
  return "$status"
}

# the tests source this script to call its functions, so the commands run only when it runs as a program.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-start}" in
    start | stop | restart) logged_main "$@" ;;
    *) main "$@" ;;
  esac
fi
