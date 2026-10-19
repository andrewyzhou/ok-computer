// the shapes of the google and signals api. the web pages import this file, so it holds types only.

export interface GoogleAccountView {
  alias: string;
  // the address that okc.config.json expects, and the address of the last sign-in.
  expected: string | null;
  email: string | null;
  status: 'signed_out' | 'ok' | 'needs_auth';
  authorizedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  alertedAt: string | null;
  failures: number;
  calls24h: number;
  errors24h: number;
  // one sentence that tells the owner what to do, or null when nothing is needed.
  nextStep: string | null;
}

export interface GooglePage {
  configured: boolean;
  clientId: string | null;
  // false until the owner uploads the client file. the client id alone, from okc.config.json, is not enough to sign in.
  clientStored: boolean;
  send: boolean;
  pollMinutes: number;
  sessions: string[];
  accounts: GoogleAccountView[];
  lastPoll: { runId: string | null; status: string; startedAt: string; endedAt: string | null; note: string | null } | null;
  tools: Array<{ name: string; risk: string; description: string }>;
}

export interface GoogleRequestRow {
  id: number;
  account: string | null;
  runId: string | null;
  toolCallId: string | null;
  method: string;
  url: string;
  request: string | null;
  status: number | null;
  response: string | null;
  responseBlob: string | null;
  error: string | null;
  latencyMs: number | null;
  createdAt: string;
}

export interface SignalRow {
  id: number;
  source: string;
  account: string;
  kind: string;
  summary: string | null;
  occursAt: string | null;
  state: string;
  label: string | null;
  labelModelCallId: number | null;
  detectors: Array<{ name: string; detail: string }> | null;
  runId: string | null;
  seenAt: string;
  handledAt: string | null;
  handledAs: 'notified' | 'seen' | 'filtered' | 'stale' | null;
  handledBy: string | null;
  // the message that the heartbeat sent, when it notified.
  notification: string | null;
}
