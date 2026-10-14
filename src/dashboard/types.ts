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
  // the model call of the reviewer. the run timeline shows it here, inside the tool call that it checked.
  reviewerCall?: ModelCallRow;
}

// one row of the policy page. the run link opens the call with its input and its reviewer call.
export interface PolicyListRow extends PolicyDecisionRow {
  runId: string;
  sessionKey: string;
  toolName: string;
}

export interface PolicyRuleRow {
  id: string;
  tool: string;
  session: string | null;
  args: Record<string, string> | null;
  effect: string;
  note: string | null;
}

export interface PolicyPage {
  decisions: PolicyListRow[];
  // the rules that the app uses now: the built-in rules, then the rules of okc.policy.json.
  rules: PolicyRuleRow[];
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
  // abandoned, late, interrupted or unsent. a delegate call whose child still runs has no row yet, and is running.
  outcome: string;
  policy: PolicyDecisionRow | null;
  // the integration that ran the tool, and the json-rpc messages of the call. a built-in tool has none.
  serverId: string | null;
  mcpMessages: McpMessageRow[];
  // the child run that a delegate call started. the run page shows its timeline inside the call.
  child?: SubagentLink;
}

// the link between a child run and the delegate call of its parent. a child that never started has no status.
export interface SubagentLink {
  parentRunId: string;
  toolCallId: string;
  childRunId: string;
  profile: string;
  status: string | null;
  costUsd: number | null;
}

// a payload over 8 kb is in the blob store. payload is then null, and the page loads it on demand. unsent marks a
// request that the transport refused after its out row was written.
export interface McpMessageRow {
  id: number;
  serverId: string;
  direction: 'out' | 'in' | 'unsent';
  method: string | null;
  rpcId: string | null;
  runId: string | null;
  toolCallId: string | null;
  latencyMs: number | null;
  createdAt: string;
  payload: unknown;
  payloadBlob: string | null;
  // the message of a json-rpc error, of a tool result with isError, or of a refused send.
  error: string | null;
}

export interface IntegrationToolRow {
  name: string;
  mcpName: string;
  description: string;
  risk: string;
  // okc.integrations.json, or the default with the hint of the server.
  riskFrom: string;
  inputSchema: Record<string, unknown>;
}

// the live state of the dashboard's own process, with counts from the database.
export interface IntegrationSummary {
  id: string;
  kind: string;
  target: string;
  sessions: string[];
  untrustedOutput: boolean;
  state: { status: string; error?: string; retryAt?: string; server?: { name: string; version: string } };
  paused: boolean;
  auth: string;
  authorizedAt: string | null;
  tokenExpiresAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  withheldScopes?: string[];
  authUrl?: string;
  oauthApp?: { redirectUrl: string; callback: 'loopback' | 'paste'; clientRef?: string };
  catalogHash?: string;
  catalogStored?: boolean;
  tools: IntegrationToolRow[];
  rejected: Array<{ mcpName: string; reason: string }>;
  // missing: tools.allow names them, and the last tool list does not have them. hidden: the server has them, and
  // tools.allow does not name them. unknown: no tool list was seen since tools.allow named them.
  missing: string[];
  hidden: string[];
  unknown: string[];
  calls24h: number;
  errors24h: number;
  lastMessageAt: string | null;
}

export interface CatalogVersion {
  hash: string;
  createdAt: string;
  toolCount: number;
  // the change from the version before. the first version has none.
  diff: { added: string[]; removed: string[]; changed: Array<{ name: string; fields: string[] }> } | null;
}

export interface IntegrationDetail extends IntegrationSummary {
  catalogs: CatalogVersion[];
  calls: ToolCallRow[];
  messages: McpMessageRow[];
}

// a model call holds the tool calls that its response asked for. a tool call that ran after an approval has no
// such model call, so it is an item of its own. reviews are the reviewer calls with no verdict that checked the tool
// calls of the turn.
export type TimelineItem = { kind: 'model'; call: ModelCallRow; tools: ToolCallRow[]; reviews?: ModelCallRow[] } | { kind: 'tool'; call: ToolCallRow };

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
  // a child run names the delegate call of its parent.
  parent: SubagentLink | null;
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
