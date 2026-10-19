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
# pwd -P gives the physical path, so a start through a folder link and a start through the real path name the same
# root, and the plist holds that same path.
root="$(cd -P "$(dirname "$script")/.." && pwd -P)"
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

# bootout returns before launchd has removed the job, and a bootstrap before that fails with "5: Input/output error".
# so this waits up to 5 seconds until launchctl print fails.
launchd_bootout() {
  launchctl bootout "$(domain)/$label" || true
  local tries=25
  while ((tries > 0)) && launchd_loaded; do
    sleep 0.2
    tries=$((tries - 1))
  done
}

# two starts at the same moment both saw no agent and both started node, and the pid file could keep the one that
# failed. mkdir is atomic, so only one start runs the check and the start at a time. macos has no flock. the lock
# holds the pid of its shell, and a lock whose shell ended is stale.
start_lock="$data/okc.start.lock"
take_start_lock() {
  mkdir -p "$data"
  # a build can run under the lock, so a live holder gets up to 10 minutes.
  local tries=3000 empty=0 holder
  until mkdir "$start_lock" 2>/dev/null; do
    holder="$(cat "$start_lock/pid" 2>/dev/null || true)"
    if [[ "$holder" =~ ^[0-9]+$ ]]; then
      empty=0
      if ! kill -0 "$holder" 2>/dev/null; then rm -rf "$start_lock"; fi
    else
      # the holder writes its pid right after the mkdir. a lock that stays without a pid for 2 seconds belongs to a
      # start that ended in between.
      empty=$((empty + 1))
      if ((empty >= 10)); then
        rm -rf "$start_lock"
        empty=0
      fi
    fi
    tries=$((tries - 1))
    ((tries > 0)) || fail "another okc start holds $start_lock. delete it when no okc runs."
    sleep 0.2
  done
  echo "$$" >"$start_lock/pid"
  trap 'rm -rf "$start_lock"' EXIT
}

drop_start_lock() {
  rm -rf "$start_lock"
  trap - EXIT
}

# a pid file stays after a crash, a logoff or a reboot, and the system then gives its id to other processes. so a
# process counts only when its command line runs the agent of this root.
# the agent may have started through another spelling of the same folder, such as a folder link, /var for
# /private/var or other letter case on macos. so the path before dist/main.js also counts when it is the same file.
pid_matches() {
  local command candidate
  command="$(LC_ALL=C ps -ww -p "$1" -o command= 2>/dev/null)" || return 1
  [[ "$command" == *"$root/dist/main.js"* ]] && return 0
  [[ "$command" == */dist/main.js* ]] || return 1
  # the command line is the node path, a space and the path of main.js, and both can hold spaces. so each space is
  # tried as the start of the path.
  candidate="${command%%/dist/main.js*}"
  while :; do
    if [[ "$candidate" == /* && "$candidate/dist/main.js" -ef "$root/dist/main.js" ]]; then return 0; fi
    [[ "$candidate" == *' '* ]] || return 1
    candidate="${candidate#* }"
  done
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
  local node
  node="$(find_node)"
  if found="$("$node" -e "$script" "$root" "$config" 2>/dev/null)"; then
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
# seconds, and linux computes it from the boot time and the clock ticks, so it can be up to a second early. the stamp
# counts as newer only when it is more than a second after the start that ps gives.
code_is_newer() {
  build_is_old && return 0
  local started node
  started="$(LC_ALL=C ps -p "$1" -o lstart= 2>/dev/null)" || return 1
  node="$(find_node)" || return 1
  "$node" -e '
    const [started, stamp] = process.argv.slice(1);
    const built = Math.floor(require("node:fs").statSync(stamp).mtimeMs / 1000) * 1000;
    process.exit(built > Date.parse(started) + 1000 ? 0 : 1);' "$started" "$stamp"
}

# OKC_NODE names the node of the agent, so a machine with several versions can pick one that is not first on the path.
# the errors go to stderr, because the callers read the path from stdout.
find_node() {
  local found
  if [[ -n "${OKC_NODE:-}" ]]; then
    [[ -f "$OKC_NODE" && -x "$OKC_NODE" ]] || fail "OKC_NODE is $OKC_NODE, and that is not a program that can run." >&2
    found="$OKC_NODE"
  else
    has node || fail 'node is not on the path. put it on the path or set OKC_NODE to its full path.' >&2
    found="$(command -v node)"
  fi
  # a relative entry on the path gives a relative node, and launchd cannot start that. only the folder is made
  # absolute, so a link such as /opt/homebrew/bin/node stays a link, and a brew cleanup of the old version does not
  # break the login agent.
  if [[ "$found" != /* ]]; then found="$(cd "$(dirname "$found")" && pwd)/$(basename "$found")"; fi
  echo "$found"
}

# the same range as engines in package.json. the tests check that the two agree.
node_major_min=24
node_major_max=26

# a brew upgrade can move the node of the path to a version outside engines, so the install checks the version
# before it writes the login agent.
check_node_version() {
  local version major
  version="$("$1" -p 'process.versions.node' 2>/dev/null)" || fail "$1 does not run."
  major="${version%%.*}"
  if [[ ! "$major" =~ ^[0-9]+$ ]] || ((major < node_major_min || major > node_major_max)); then
    fail "$1 is node $version, and ok computer needs node $node_major_min to $node_major_max. set OKC_NODE to the full path of a node in that range."
  fi
}

start_agent() {
  local open=1 arg
  for arg in "$@"; do
    if [[ "$arg" == '--no-open' ]]; then open=0; fi
  done
  take_start_lock
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
      # OKC_SERVICE tells the agent that its stdin is /dev/null, so it runs no cli that would end at once.
      (cd "$root" && OKC_SERVICE=1 exec nohup "$node" "$root/dist/main.js" </dev/null >>"$launcher_log" 2>&1) &
      echo "$!" >"$pid_file"
    fi
    echo 'ok computer started.'
  fi
  drop_start_lock
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
      launchd_bootout
    else
      kill -TERM "$pid" 2>/dev/null || true
      if ! wait_for_exit "$pid" 5; then kill -KILL "$pid" 2>/dev/null || true; fi
    fi
    end_chrome
  fi
  rm -f "$pid_file"
  echo 'ok computer stopped.'
}

# playwright starts chrome in its own process group, and a forced stop skips the end of the agent, so the chrome of
# the agent profile can outlive it. that chrome would keep the profile lock. the match is on the plain text of the
# command line, so a path with special characters needs no escape.
end_chrome() {
  local profile="--user-data-dir=$agent_data/browser/profile" line pid command
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    pid="${line%% *}"
    command="${line#* }"
    # the profile path ends at a space or at the end, so the profile of another root with a longer name does not count.
    if [[ "$pid" =~ ^[0-9]+$ && ("$command" == *"$profile "* || "$command" == *"$profile") ]]; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done < <(LC_ALL=C ps -A -ww -o pid= -o command= 2>/dev/null || true)
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
  # launchd counts the starts of the job and keeps the code of its last exit.
  local output line re='^[[:space:]]*(runs|last exit code) = (.*)$'
  if output="$(launchd_print)"; then
    while IFS= read -r line; do
      if [[ "$line" =~ $re ]]; then echo "launchd ${BASH_REMATCH[1]}: ${BASH_REMATCH[2]}"; fi
    done <<<"$output"
  fi
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
  local node
  node="$(find_node)"
  if [[ -n "${2:-}" ]]; then
    (cd "$root" && "$node" dist/browser/login.js "$2")
  else
    (cd "$root" && "$node" dist/browser/login.js)
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
  # the node check comes first, so a node outside engines leaves the running agent and its login agent as they are.
  local node logs path
  node="$(find_node)"
  check_node_version "$node"
  # a second agent cannot hold the data folder next to the one that launchd starts. an agent of launchd also gets the
  # graceful stop first, because the bootout below would stop it at once.
  if agent_pid; then stop_agent; fi
  # launchd starts dist/main.js at once, because of RunAtLoad.
  if build_is_old; then run_build; fi
  link_command
  logs="$data/logs"
  mkdir -p "$logs" "$(dirname "$plist")"
  path="$(dirname "$node"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  sed -e "s|@@NODE@@|$(fill "$node")|g" -e "s|@@ROOT@@|$(fill "$root")|g" -e "s|@@PATH@@|$(fill "$path")|g" \
    -e "s|@@LOGS@@|$(fill "$logs")|g" "$template" >"$plist"
  if has plutil; then plutil -lint "$plist" >/dev/null || fail "the login agent at $plist is not a valid plist."; fi
  if launchd_loaded; then launchd_bootout; fi
  launchctl bootstrap "$(domain)" "$plist"
  echo "installed: okc command and the $label login agent."
}

uninstall_agent() {
  stop_agent
  if launchd_loaded; then launchd_bootout; fi
  rm -f "$plist"
  local command="$HOME/.local/bin/okc"
  # -ef also matches a link that an install through another spelling of the root wrote.
  if [[ -L "$command" && "$command" -ef "$root/scripts/okc.sh" ]]; then rm -f "$command"; fi
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
  # launchd keeps its log files open and appends to them, so they are cut in place to their last 1000 lines and not
  # deleted.
  local file kept
  for file in "$data/logs/launchd.out.log" "$data/logs/launchd.err.log"; do
    if [[ -f "$file" ]] && (($(wc -c <"$file") > 1048576)); then
      kept="$(tail -n 1000 "$file")"
      printf '%s\n' "$kept" >"$file"
    fi
  done
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
