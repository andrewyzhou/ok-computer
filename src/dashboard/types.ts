// these are the shapes of the dashboard api. the web app imports this file too, so it has no imports.

export interface Meta {
  timeZone: string;
  now: string;
}

export interface RunRow {
  id: string;
  sessionKey: string;
  trigger: string;
  slot: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  costUsd: number | null;
  modelCalls: number;
  toolCalls: number;
}

export interface ModelCallRow {
  id: number;
  runId: string | null;
  slot: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  latencyMs: number;
  stopReason: string | null;
  error: string | null;
  createdAt: string;
  // the hash of the tool list that the call offered, and the number of tools in it.
  toolCatalogHash: string | null;
  toolCount: number | null;
}

export interface ModelCallBody {
  request: unknown;
  response: unknown;
}

export interface PolicyDecisionRow {
  id: number;
  decision: string;
  rule: string;
  reason: string;
  reviewerModelCallId: number | null;
  reviewerVerdict: string | null;
  reviewerReason: string | null;
  approvalId: number | null;
  approvalStatus: string | null;
  // the untrusted sources that the session had read when the policy decided.
  taint: Array<{ source: string; toolName: string; runId: string | null; toolCallId: string; at: string }>;
  createdAt: string;
}

export interface ToolCallRow {
  id: number;
  runId: string;
  toolCallId: string;
  name: string;
  input: unknown;
  // output holds the exact text that the model got.
  output: { content: string; isError?: boolean };
  isError: boolean;
  durationMs: number;
  createdAt: string;
  source: string;
  riskLevel: string | null;
  tainted: boolean;
  untrustedSource: string | null;
  truncated: boolean;
  resultHandle: string | null;
  // the raw result is rawResultBlob ?? output.content. the blob exists only when the model saw other text: a
  // preview, a wrapped text, or a late result. such a row without a blob lost its raw text in a failed blob write.
  rawResultBlob: string | null;
  // one word from outcomeOf in outcome.ts: ran, failed, invalid, denied, held, waiting, approved, declined, expired,
  // abandoned, late or interrupted.
  outcome: string;
  policy: PolicyDecisionRow | null;
}

// a model call holds the tool calls that its response asked for. a tool call that ran after an approval has no
// such model call, so it is an item of its own.
export type TimelineItem = { kind: 'model'; call: ModelCallRow; tools: ToolCallRow[] } | { kind: 'tool'; call: ToolCallRow };

export interface BlobBody {
  hash: string;
  size: number;
  mime: string;
  createdAt: string;
  text: string;
}

export interface ToolCatalog {
  hash: string;
  createdAt: string;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

export interface EventRow {
  id: number;
  sessionKey: string;
  runId: string | null;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RunDetail {
  run: RunRow;
  timeline: TimelineItem[];
  events: EventRow[];
}

export interface SessionRow {
  sessionKey: string;
  events: number;
  compactions: number;
  firstAt: string;
  lastAt: string;
}

export type ContextBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; toolCallId: string; content: string; isError: boolean };

export type ContextMessage =
  | { role: 'user'; content: ContextBlock[] }
  | { role: 'assistant'; text: string; toolCalls: Array<{ id: string; name: string; input: unknown }>; content: unknown[] };

export interface ContextView {
  system: string;
  tools: Array<{ name: string; description: string }>;
  messages: ContextMessage[];
  estimatedTokens: number;
}

export interface GoalRow {
  id: number;
  day: string;
  title: string;
  eta: string | null;
  status: string;
  completedAt: string | null;
  note: string | null;
}

export interface GoalStatsRow {
  from: string;
  to: string;
  daysWithGoals: number;
  goals: number;
  done: number;
  doneOnTime: number;
  dropped: number;
  open: number;
  hitRate: number | null;
  setStreak: number;
  allDoneStreak: number;
}

export interface GoalsPage {
  today: string;
  goals: GoalRow[];
  days: Array<{ day: string; goals: number; done: number }>;
  stats7: GoalStatsRow;
  stats30: GoalStatsRow;
}

export interface AutomationRow {
  id: string;
  name: string;
  schedule: string;
  payloadType: string;
  sessionMode: string;
  slot: string;
  enabled: boolean;
  createdBy: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  consecutiveFailures: number;
}

export interface AutomationRunRow {
  id: number;
  automationId: string;
  runId: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

export interface HeartbeatStatus {
  automation: AutomationRow | null;
  every: string;
  activeHours: { start: string; end: string };
  inActiveHours: boolean;
  checklist: string;
  lastRun: AutomationRunRow | null;
}

export interface Overview {
  day: string;
  costUsd: number;
  runs: number;
  failedRuns: number;
  modelErrors: number;
  openGoals: GoalRow[];
  nextAutomations: AutomationRow[];
  heartbeat: HeartbeatStatus;
  blobs: { count: number; bytes: number };
}

export interface ApprovalRow {
  id: number;
  runId: string;
  sessionKey: string;
  toolName: string;
  summary: string;
  // the full input, redacted.
  input: unknown;
  status: string;
  requestedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface MemoryFile {
  path: string;
  size: number;
  modifiedAt: string;
}

export interface CostGroup {
  key: string;
  costUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface CostPage {
  from: string;
  to: string;
  days: CostGroup[];
  slots: CostGroup[];
  models: CostGroup[];
  // calls of a model without a price have no cost. the totals leave them out.
  unpricedCalls: number;
}

export interface LogLine {
  ts: string;
  level: string;
  msg: string;
  [field: string]: unknown;
}

export type StreamMessage =
  | { kind: 'event'; event: EventRow }
  | { kind: 'run'; run: RunRow }
  | { kind: 'log'; line: LogLine };
