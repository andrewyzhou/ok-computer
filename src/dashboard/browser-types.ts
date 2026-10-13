// the shapes of the browser api. the page imports them, so this file imports nothing.

export interface BrowserTaskSummary {
  id: string;
  kind: 'task' | 'search';
  sessionKey: string;
  runId: string | null;
  allowlist: string[];
  status: 'open' | 'closed' | 'crashed' | 'interrupted';
  endReason: string | null;
  hasTrace: boolean;
  traceBytes: number | null;
  traceError: string | null;
  startedAt: string;
  endedAt: string | null;
  steps: number;
  // the steps that blocked a request, and the requests that approved submits sent.
  blocked: number;
  sent: number;
}

// a search engine pauses after a captcha or a consent page. until is the end of the pause.
export interface SearchEngineState {
  id: string;
  label: string;
  paused: boolean;
  until: string | null;
  reason: string | null;
  strikes: number;
}

export interface BrowserOverview {
  engines: SearchEngineState[];
  // a chrome holds the agent profile: the agent itself, or okc browser login.
  profileInUse: boolean;
  tasks: BrowserTaskSummary[];
}

export interface BrowserStep {
  id: number;
  runId: string | null;
  toolCallId: string | null;
  action: string;
  target: string | null;
  urlBefore: string | null;
  urlAfter: string | null;
  snapshotBlob: string | null;
  screenshotBlob: string | null;
  consoleErrors: string[];
  blockedRequests: Array<{ url: string; reason: string }>;
  sent: Array<{ method: string; url: string }>;
  // the hosts off the allowlist that a request of the step reached, for example an image. a page script can carry
  // typed text in such a request.
  offsiteHosts: string[];
  error: string | null;
  durationMs: number;
  createdAt: string;
  // the tool call of the step: its risk, and the policy decision that let it run.
  risk: string | null;
  decision: string | null;
  rule: string | null;
  approvalId: number | null;
}

export interface BrowserTaskDetail {
  task: BrowserTaskSummary;
  steps: BrowserStep[];
}
