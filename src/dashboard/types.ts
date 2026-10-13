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
}

export interface ModelCallBody {
  request: unknown;
  response: unknown;
}

export interface ToolCallRow {
  id: number;
  runId: string;
  toolCallId: string;
  name: string;
  input: unknown;
  output: { content: string; isError?: boolean };
  isError: boolean;
  durationMs: number;
  createdAt: string;
}

export type TimelineItem = { kind: 'model'; call: ModelCallRow } | { kind: 'tool'; call: ToolCallRow };

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
}

export interface ApprovalRow {
  id: number;
  runId: string;
  sessionKey: string;
  toolName: string;
  summary: string;
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
