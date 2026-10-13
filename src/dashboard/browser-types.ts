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
  blocked: number;
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
  error: string | null;
  durationMs: number;
  createdAt: string;
}

export interface BrowserTaskDetail {
  task: BrowserTaskSummary;
  steps: BrowserStep[];
}
