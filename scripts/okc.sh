#!/usr/bin/env bash
# this script controls the agent from any terminal on macos and linux.
# commands: start, stop, restart, status, open, logs, browser login [url], install, uninstall.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
data="$root/data"
url='http://127.0.0.1:4317'
label='com.okcomputer.agent'

not_built() {
  echo "okc $1 is not built yet." >&2
  exit 1
}

start_agent() { not_built start; }
stop_agent() { not_built stop; }
show_status() { not_built status; }
open_dashboard() { not_built open; }
show_logs() { not_built logs; }
browser_login() { not_built browser; }
install_agent() { not_built install; }
uninstall_agent() { not_built uninstall; }

main() {
  local command="${1:-start}"
  case "$command" in
    start) start_agent "${@:2}" ;;
    stop) stop_agent ;;
    restart) stop_agent && start_agent "${@:2}" ;;
    status) show_status ;;
    open) open_dashboard ;;
    logs) show_logs ;;
    browser) browser_login "${@:2}" ;;
    install) install_agent ;;
    uninstall) uninstall_agent ;;
    *) echo 'usage: okc [start|stop|restart|status|open|logs|browser login [url]|install|uninstall] [--no-open]' ;;
  esac
}

# the tests source this script to call its functions, so the commands run only when it runs as a program.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  : "$data" "$url" "$label"
  main "$@"
fi
