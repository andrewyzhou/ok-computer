// a restart from the page is a graceful stop with RESTART_EXIT_CODE. both supervisors start the agent again after it:
// launchd because the exit is not a success (scripts/macos/com.okcomputer.agent.plist), and scripts/run.ps1 after
// every exit. a process that no supervisor runs would stay stopped, so the page offers the button only under one.
export const RESTART_EXIT_CODE = 75;

// supervised tells if a supervisor starts this process again after it stops.
export function supervised(env: NodeJS.ProcessEnv): boolean {
  return env.OKC_SERVICE === '1';
}
