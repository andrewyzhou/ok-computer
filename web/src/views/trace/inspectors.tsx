import { useState, type ReactNode } from 'react';
import type { BrowserTaskDetail } from '../../../../src/dashboard/browser-types';
import type { GoogleRequestRow } from '../../../../src/dashboard/google-types';
import type {
  ApprovalRow,
  McpMessageRow,
  ModelCallBody,
  ModelCallRow,
  PolicyDecisionRow,
  RunDetail,
  SandboxExecDetail,
  Span,
  TimelineItem,
  ToolCallRow,
  ToolCatalog,
} from '../../../../src/dashboard/types';
import { apiUrl, useApi } from '../../api';
import { Expand, Load } from '../../components';
import { duration, ms, time, tokens, usd } from '../../format';
import { McpMessages } from '../../pages/Integrations';
import { GoogleRequests } from '../../pages/Google';
import { ApprovalCard, ButtonLink, CodeBlock, Facts, Section, Segmented, Status } from '../../ui';
import { BlobCode, BlobOnDemand, ExecSummary, LoadRow } from '../sandbox/parts';
import { runOfSpan, traceHref } from './tree';

// the inspectors of the details panel, one for each kind of span. each loads the full row through the endpoint of its
// kind. an error shows in the panel, and the waterfall stays.

export interface InspectorProps {
  span: Span;
  // the run of the page, and every span of it, so an inspector can link to another span.
  runId: string;
  spans: Span[];
  byId: ReadonlyMap<string, Span>;
}

const runHref = (id: string) => `#/runs/${encodeURIComponent(id)}`;

// raw is the value as the server sent it, with no spaces. formatted has line breaks for reading. both are the same
// json, so formatted never hides a byte of the stored body.
type BodyMode = 'raw' | 'formatted';
let lastMode: BodyMode = 'formatted';

export function jsonText(value: unknown, mode: BodyMode): string {
  return (mode === 'raw' ? JSON.stringify(value) : JSON.stringify(value, null, 2)) ?? 'undefined';
}

function spanDuration(span: Span): string {
  return span.endMs === null ? 'running' : ms(span.endMs - span.startMs);
}

// the model inspectors show the usage of the stored row, so their span facts leave it out.
export function SpanFacts({ span, usage = true }: { span: Span; usage?: boolean }) {
  return (
    <Facts
      items={[
        { label: 'Kind', value: span.kind },
        { label: 'Span', value: <code>{span.id}</code> },
        { label: 'Status', value: span.status ? <Status value={span.status} /> : '-' },
        { label: 'Start', value: `${time(span.startAt)}, at ${ms(span.startMs)}` },
        { label: 'Duration', value: spanDuration(span) },
        usage && span.costUsd !== null && { label: 'Cost', value: usd(span.costUsd) },
        usage && (span.inputTokens !== null || span.outputTokens !== null) && {
          label: 'Tokens',
          value: `in ${tokens(span.inputTokens ?? 0)}, out ${tokens(span.outputTokens ?? 0)}`,
        },
        span.error !== null && { label: 'Error', value: <span className="error-text">{span.error}</span> },
      ]}
    />
  );
}

// the model calls of a timeline: the calls of the turns, their reviewer calls with no verdict, and the reviewer call of
// each policy decision.
function modelRows(timeline: TimelineItem[]): ModelCallRow[] {
  return timeline.flatMap((item) => {
    const tools = item.kind === 'model' ? item.tools : [item.call];
    const reviewers = tools.flatMap((tool) => (tool.policy?.reviewerCall ? [tool.policy.reviewerCall] : []));
    return item.kind === 'model' ? [item.call, ...(item.reviews ?? []), ...reviewers] : reviewers;
  });
}

function toolRows(timeline: TimelineItem[]): ToolCallRow[] {
  return timeline.flatMap((item) => (item.kind === 'model' ? item.tools : [item.call]));
}

function CatalogBlock({ hash }: { hash: string }) {
  const loaded = useApi<ToolCatalog>(`/api/tool-catalogs/${encodeURIComponent(hash)}`);
  return (
    <Load loaded={loaded}>
      {(catalog) => <CodeBlock label={`catalog ${hash.slice(0, 12)}, first offered ${time(catalog.createdAt)}`} text={JSON.stringify(catalog.tools, null, 2)} />}
    </Load>
  );
}

function ModelRowFacts({ call }: { call: ModelCallRow }) {
  return (
    <>
      <Facts
        items={[
          { label: 'Model', value: `${call.provider}/${call.model}, slot ${call.slot}` },
          {
            label: 'Tokens',
            value: `in ${tokens(call.inputTokens)}, out ${tokens(call.outputTokens)}, cache read ${tokens(call.cacheReadTokens)}, cache write ${tokens(call.cacheWriteTokens)}`,
          },
          { label: 'Cost', value: usd(call.costUsd) },
          { label: 'Latency', value: ms(call.latencyMs) },
          { label: 'Stop reason', value: call.stopReason ?? '-' },
          call.error !== null && { label: 'Error', value: <span className="error-text">{call.error}</span> },
        ]}
      />
      {call.toolCatalogHash ? (
        <Expand label={`${call.toolCount ?? '?'} tools offered (catalog ${call.toolCatalogHash.slice(0, 8)})`}>
          {() => <CatalogBlock hash={call.toolCatalogHash!} />}
        </Expand>
      ) : null}
    </>
  );
}

// the stored request and response of a model call, byte for byte.
export function ModelBody({ id }: { id: number }) {
  const [mode, setMode] = useState<BodyMode>(lastMode);
  const loaded = useApi<ModelCallBody>(`/api/model-calls/${id}`);
  const change = (next: BodyMode) => {
    lastMode = next;
    setMode(next);
  };
  return (
    <div className="trace-body">
      <Segmented
        label="body format"
        value={mode}
        onChange={change}
        options={[
          { value: 'raw', label: 'raw' },
          { value: 'formatted', label: 'formatted' },
        ]}
      />
      <Load loaded={loaded}>
        {(body) => (
          <>
            <CodeBlock label="Request" text={jsonText(body.request, mode)} />
            <CodeBlock label="Response" text={jsonText(body.response, mode)} />
          </>
        )}
      </Load>
    </div>
  );
}

function ModelInspector({ span, runId, byId, modelCallId }: InspectorProps & { modelCallId: number }) {
  const run = runOfSpan(span, byId, runId);
  const detail = useApi<RunDetail>(`/api/runs/${encodeURIComponent(run)}`);
  const row = detail.data ? modelRows(detail.data.timeline).find((call) => call.id === modelCallId) : undefined;
  return (
    <>
      {row ? <ModelRowFacts call={row} /> : null}
      {detail.error ? <p className="muted">The timeline of run {run} did not load: {detail.error}</p> : null}
      <ModelBody id={modelCallId} />
    </>
  );
}

// these outcomes need a sentence, because the model saw a note and not the result of the tool.
const OUTCOME_NOTES: Record<string, string> = {
  abandoned: 'The run stopped while the tool ran. The model was told that the effect is unknown.',
  late: 'The run stopped while the tool ran, and the tool finished later. The raw result is the late result.',
  interrupted: 'The app stopped while the tool ran. The model got a note that the effect is unknown.',
  unsent: 'The integration did not send the call, so the tool did not run.',
};
const NO_RESULT = new Set(['abandoned', 'interrupted']);

// the raw result is rawResultBlob, or the model view when the model saw the result unchanged. a preview, a wrapped
// text and a late result always get a blob, so such a row without one lost its raw text in a failed blob write.
function RawResult({ call }: { call: ToolCallRow }) {
  if (call.rawResultBlob) return <BlobCode hash={call.rawResultBlob} label="Raw result" />;
  const lost = call.truncated || call.untrustedSource !== null || call.outcome === 'late';
  if (lost) return <p className="muted">The raw result was not stored.</p>;
  if (NO_RESULT.has(call.outcome)) return <p className="muted">The tool gave no result.</p>;
  return (
    <>
      <p className="muted">The model saw the raw result unchanged.</p>
      <CodeBlock label="Raw result" text={call.output.content} />
    </>
  );
}

function SpanLink({ spans, runId, find, children }: { spans: Span[]; runId: string; find: (span: Span) => boolean; children: ReactNode }) {
  const target = spans.find(find);
  if (!target) return null;
  return <a href={traceHref(runId, target.id)}>{children}</a>;
}

function PolicyFacts({ policy, spans, runId }: { policy: PolicyDecisionRow; spans: Span[]; runId: string }) {
  const reviewer = policy.reviewerModelCallId;
  return (
    <Facts
      items={[
        {
          label: 'Decision',
          value: (
            <>
              <Status value={policy.decision} /> by {policy.rule}
            </>
          ),
        },
        { label: 'Reason', value: policy.reason },
        policy.reviewerVerdict !== null && {
          label: 'Reviewer',
          value: (
            <>
              <Status value={policy.reviewerVerdict} /> {policy.reviewerReason}
            </>
          ),
        },
        reviewer !== null && {
          label: 'Reviewer call',
          value: (
            <>
              #{reviewer}{' '}
              <SpanLink
                spans={spans}
                runId={runId}
                find={(span) => span.id === `model:${reviewer}` || ((span.ref.kind === 'review' || span.ref.kind === 'model') && span.ref.modelCallId === reviewer)}
              >
                open the reviewer span
              </SpanLink>
            </>
          ),
        },
        {
          label: 'Taint',
          value: policy.taint.length ? (
            <ul className="trace-list">
              {policy.taint.map((each, index) => (
                <li key={index}>
                  {each.source}, read by {each.toolName} at {time(each.at)}
                  {each.runId ? (
                    <>
                      {' '}
                      in <a href={runHref(each.runId)}>run {each.runId}</a>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            'none'
          ),
        },
        policy.approvalId !== null && {
          label: 'Approval',
          value: (
            <>
              <a href="#/approvals">#{policy.approvalId}</a> {policy.approvalStatus ? <Status value={policy.approvalStatus} /> : null}
            </>
          ),
        },
      ]}
    />
  );
}

function ToolBody({ call, spans, runId }: { call: ToolCallRow; spans: Span[]; runId: string }) {
  const google = call.serverId === 'google' || call.source === 'google' || call.name.startsWith('google__');
  return (
    <>
      <Facts
        items={[
          { label: 'Tool', value: <code>{call.name}</code> },
          { label: 'Outcome', value: <Status value={call.outcome} /> },
          { label: 'Risk', value: call.riskLevel ?? '-' },
          { label: 'Source', value: call.serverId ? `${call.source}, ${call.serverId}` : call.source },
          { label: 'Duration', value: ms(call.durationMs) },
          { label: 'Call id', value: <code>{call.toolCallId}</code> },
          call.tainted && { label: 'Tainted', value: <Status value="tainted" /> },
          call.resultHandle !== null && { label: 'Handle', value: <code>{call.resultHandle}</code> },
        ]}
      />
      {call.child ? (
        <ButtonLink size="sm" icon="trace" href={traceHref(call.child.childRunId)}>
          Trace of the sub-agent
        </ButtonLink>
      ) : null}
      <Section title="Input">
        <CodeBlock label="input" text={JSON.stringify(call.input, null, 2) ?? 'undefined'} />
      </Section>
      <Section title="Result">
        {call.truncated ? (
          <p className="muted">
            The model got a preview and the handle <code>{call.resultHandle}</code>.
          </p>
        ) : null}
        {call.untrustedSource ? <p className="muted">The result came from {call.untrustedSource}, so the model got it inside an untrusted wrapper.</p> : null}
        {OUTCOME_NOTES[call.outcome] ? <p className="muted">{OUTCOME_NOTES[call.outcome]}</p> : null}
        <CodeBlock label="What the model saw" text={call.output.content} />
        <RawResult call={call} />
      </Section>
      <Section title="Policy">
        {call.policy ? <PolicyFacts policy={call.policy} spans={spans} runId={runId} /> : <p className="muted">No policy decision was stored for this call.</p>}
      </Section>
      {google ? (
        <Section title="Requests to Google">
          <GoogleRequests query={`runId=${encodeURIComponent(call.runId)}&toolCallId=${encodeURIComponent(call.toolCallId)}`} />
        </Section>
      ) : call.serverId ? (
        <Section title={`Messages with ${call.serverId}`}>
          <McpMessages messages={call.mcpMessages} />
        </Section>
      ) : null}
    </>
  );
}

// a tool call is in the timeline of its own run. the trace nests a child run under its sub-agent span, so the call is
// looked up in each candidate run in turn: the run of the span first, then the run of the page.
function ToolLookup({ runs, toolCallId, rowId, spans, runId }: { runs: string[]; toolCallId: string; rowId: number; spans: Span[]; runId: string }) {
  const [first, ...rest] = runs;
  const loaded = useApi<RunDetail>(first ? `/api/runs/${encodeURIComponent(first)}` : null);
  if (!first) return <p className="muted">The tool call {toolCallId} is not in the timeline of this run.</p>;
  if (loaded.error) return rest.length ? <ToolLookup runs={rest} toolCallId={toolCallId} rowId={rowId} spans={spans} runId={runId} /> : <p className="error-box">Could not load: {loaded.error}</p>;
  if (!loaded.data) return <p className="muted">Loading the tool call…</p>;
  const rows = toolRows(loaded.data.timeline);
  const call = rows.find((row) => row.id === rowId) ?? rows.find((row) => row.toolCallId === toolCallId);
  if (!call) return <ToolLookup runs={rest} toolCallId={toolCallId} rowId={rowId} spans={spans} runId={runId} />;
  return <ToolBody call={call} spans={spans} runId={runId} />;
}

function candidateRuns(span: Span, props: InspectorProps): string[] {
  const parent = span.parentId ? props.byId.get(span.parentId) : undefined;
  const ids = [runOfSpan(span, props.byId, props.runId), parent?.ref.kind === 'subagent' ? parent.ref.childRunId : null, props.runId];
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

function ApprovalInspector({ approvalId }: { approvalId: number }) {
  const loaded = useApi<ApprovalRow[]>('/api/approvals');
  return (
    <Load loaded={loaded}>
      {(rows) => {
        const approval = rows.find((row) => row.id === approvalId);
        return approval ? <ApprovalCard approval={approval} onDecided={loaded.reload} /> : <p className="muted">Approval #{approvalId} is not in the list of approvals.</p>;
      }}
    </Load>
  );
}

function SubagentInspector({ childRunId }: { childRunId: string }) {
  const loaded = useApi<RunDetail>(`/api/runs/${encodeURIComponent(childRunId)}`);
  return (
    <>
      <LoadRow loaded={loaded} missing="The sub-agent run did not start, or it is gone.">
        {({ run, parent }) => (
          <Facts
            items={[
              parent && { label: 'Profile', value: parent.profile },
              { label: 'Status', value: <Status value={run.status} /> },
              { label: 'Started', value: time(run.startedAt) },
              { label: 'Duration', value: duration(run.startedAt, run.endedAt) },
              { label: 'Cost', value: usd(run.costUsd) },
              { label: 'Calls', value: `${run.modelCalls} model calls, ${run.toolCalls} tool calls` },
              run.error !== null && { label: 'Error', value: <span className="error-text">{run.error}</span> },
            ]}
          />
        )}
      </LoadRow>
      <div className="trace-actions">
        <ButtonLink size="sm" variant="primary" icon="trace" href={traceHref(childRunId)}>
          Trace of the sub-agent
        </ButtonLink>
        <ButtonLink size="sm" href={runHref(childRunId)}>
          Run page
        </ButtonLink>
      </div>
    </>
  );
}

export function RunInspector({ runId }: { runId: string }) {
  const loaded = useApi<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
  return (
    <>
      <LoadRow loaded={loaded}>
        {({ run, parent }) => (
          <Facts
            items={[
              { label: 'Run', value: <code>{run.id}</code> },
              { label: 'Status', value: <Status value={run.status} /> },
              { label: 'Session', value: run.sessionKey },
              { label: 'Trigger', value: `${run.trigger}, slot ${run.slot}` },
              { label: 'Started', value: time(run.startedAt) },
              { label: 'Duration', value: duration(run.startedAt, run.endedAt) },
              { label: 'Cost', value: usd(run.costUsd) },
              { label: 'Calls', value: `${run.modelCalls} model calls, ${run.toolCalls} tool calls` },
              parent && {
                label: 'Started by',
                value: (
                  <>
                    the {parent.profile} sub-agent call of <a href={traceHref(parent.parentRunId)}>run {parent.parentRunId}</a>
                  </>
                ),
              },
              run.error !== null && { label: 'Error', value: <span className="error-text">{run.error}</span> },
            ]}
          />
        )}
      </LoadRow>
      <div className="trace-actions">
        <ButtonLink size="sm" icon="run" href={runHref(runId)}>
          Run page
        </ButtonLink>
        <ButtonLink size="sm" icon="log" href={`#/logs?runId=${encodeURIComponent(runId)}`}>
          Logs
        </ButtonLink>
      </div>
    </>
  );
}

function McpInspector({ id }: { id: number }) {
  const loaded = useApi<McpMessageRow>(`/api/mcp-messages/${id}`);
  return (
    <LoadRow loaded={loaded}>
      {(message) => (
        <>
          <Facts
            items={[
              { label: 'Server', value: message.serverId },
              { label: 'Direction', value: message.direction },
              { label: 'Method', value: message.method ?? 'response' },
              message.rpcId !== null && { label: 'Request id', value: <code>{message.rpcId}</code> },
              message.latencyMs !== null && { label: 'Latency', value: ms(message.latencyMs) },
              { label: 'Time', value: time(message.createdAt) },
              message.error !== null && { label: 'Error', value: <span className="error-text">{message.error}</span> },
            ]}
          />
          {message.payload !== null ? <CodeBlock label="payload" text={JSON.stringify(message.payload, null, 2) ?? 'undefined'} /> : null}
          {message.payloadBlob ? <BlobOnDemand hash={message.payloadBlob} label="payload" button="Load the full payload" /> : null}
          <McpMessages messages={[message]} />
        </>
      )}
    </LoadRow>
  );
}

function GoogleInspector({ id, run }: { id: number; run: string }) {
  const loaded = useApi<GoogleRequestRow[]>(`/api/google/requests?runId=${encodeURIComponent(run)}`);
  return (
    <Load loaded={loaded}>
      {(rows) => {
        const row = rows.find((each) => each.id === id);
        if (!row) return <p className="muted">Request #{id} is not in the requests of run {run}.</p>;
        return (
          <>
            <Facts
              items={[
                { label: 'Method', value: row.method },
                { label: 'URL', value: <code className="trace-break">{row.url}</code> },
                { label: 'Status', value: row.status ?? '-' },
                { label: 'Latency', value: row.latencyMs === null ? '-' : ms(row.latencyMs) },
                row.account !== null && { label: 'Account', value: row.account },
                row.error !== null && { label: 'Error', value: <span className="error-text">{row.error}</span> },
              ]}
            />
            {row.request !== null ? <CodeBlock label="Request body" text={row.request} /> : <p className="muted">The request had no body.</p>}
            {row.response !== null ? (
              <CodeBlock label={row.responseBlob ? 'Response, the start' : 'Response'} text={row.response} />
            ) : (
              <p className="muted">No response was stored.</p>
            )}
            {row.responseBlob ? <BlobOnDemand hash={row.responseBlob} label="Full response" button="Load the full response" /> : null}
          </>
        );
      }}
    </Load>
  );
}

function BrowserInspector({ taskId, stepId }: { taskId: string; stepId: number }) {
  const loaded = useApi<BrowserTaskDetail>(`/api/browser/tasks/${encodeURIComponent(taskId)}`);
  return (
    <>
      <LoadRow loaded={loaded}>
        {({ steps }) => {
          const index = steps.findIndex((step) => step.id === stepId);
          const step = steps[index];
          if (!step) return <p className="muted">Step {stepId} is not in browser task {taskId}.</p>;
          return (
            <>
              {step.screenshotBlob ? (
                <img className="trace-shot" alt={`page after step ${index + 1}`} src={apiUrl(`/api/browser/screenshots/${step.screenshotBlob}`)} />
              ) : (
                <p className="muted">No screenshot.</p>
              )}
              <Facts
                items={[
                  { label: 'Step', value: `${index + 1} of ${steps.length}` },
                  { label: 'Action', value: step.action },
                  step.target !== null && { label: 'Target', value: <code className="trace-break">{step.target}</code> },
                  { label: 'URL before', value: <span className="trace-break">{step.urlBefore ?? '-'}</span> },
                  { label: 'URL after', value: <span className="trace-break">{step.urlAfter ?? '-'}</span> },
                  { label: 'Duration', value: ms(step.durationMs) },
                  step.error !== null && { label: 'Error', value: <span className="error-text">{step.error}</span> },
                  {
                    label: 'Blocked',
                    value: step.blockedRequests.length ? (
                      <ul className="trace-list">
                        {step.blockedRequests.map((each, i) => (
                          <li key={i} className="trace-break">
                            {each.url} <span className="muted">{each.reason}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      'none'
                    ),
                  },
                  {
                    label: 'Sent',
                    value: step.sent.length ? (
                      <ul className="trace-list">
                        {step.sent.map((each, i) => (
                          <li key={i} className="trace-break">
                            {each.method} {each.url} {each.form ? <span className="muted">the approved form</span> : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      'none'
                    ),
                  },
                  {
                    label: 'Console errors',
                    value: step.consoleErrors.length ? (
                      <ul className="trace-list">
                        {step.consoleErrors.map((each, i) => (
                          <li key={i} className="trace-break">
                            {each}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      'none'
                    ),
                  },
                ]}
              />
            </>
          );
        }}
      </LoadRow>
      <div className="trace-actions">
        <ButtonLink size="sm" icon="browser" href={`#/sandbox/browser/${encodeURIComponent(taskId)}`}>
          All steps of the task
        </ButtonLink>
      </div>
    </>
  );
}

function SandboxInspector({ id }: { id: number }) {
  const loaded = useApi<SandboxExecDetail>(`/api/sandbox/execs/${id}`);
  return (
    <>
      <LoadRow loaded={loaded}>{(exec) => <ExecSummary exec={exec} />}</LoadRow>
      <div className="trace-actions">
        <ButtonLink size="sm" icon="sandbox" href={`#/sandbox/code/${id}`}>
          Open the code run
        </ButtonLink>
      </div>
    </>
  );
}

function ReviewInspector(props: InspectorProps & { modelCallId: number; toolCallId: string | null }) {
  const { spans, runId, toolCallId } = props;
  return (
    <>
      {toolCallId ? (
        <p>
          Checked the tool call <code>{toolCallId}</code>.{' '}
          <SpanLink spans={spans} runId={runId} find={(span) => span.ref.kind === 'tool' && span.ref.toolCallId === toolCallId}>
            Open the tool span
          </SpanLink>
        </p>
      ) : (
        <p className="muted">The review names no tool call.</p>
      )}
      <ModelInspector {...props} />
    </>
  );
}

export function SpanInspector(props: InspectorProps) {
  const { span } = props;
  const ref = span.ref;
  let body: ReactNode = null;
  switch (ref.kind) {
    case 'run':
      body = <RunInspector runId={ref.runId} />;
      break;
    case 'model':
      body = <ModelInspector {...props} modelCallId={ref.modelCallId} />;
      break;
    case 'review':
      body = <ReviewInspector {...props} modelCallId={ref.modelCallId} toolCallId={ref.toolCallId} />;
      break;
    case 'tool':
      body = <ToolLookup runs={candidateRuns(span, props)} toolCallId={ref.toolCallId} rowId={ref.toolCallRowId} spans={props.spans} runId={props.runId} />;
      break;
    case 'approval':
      body = <ApprovalInspector approvalId={ref.approvalId} />;
      break;
    case 'subagent':
      body = <SubagentInspector childRunId={ref.childRunId} />;
      break;
    case 'mcp':
      body = <McpInspector id={ref.mcpMessageId} />;
      break;
    case 'google':
      body = <GoogleInspector id={ref.googleRequestId} run={runOfSpan(span, props.byId, props.runId)} />;
      break;
    case 'browser':
      body = <BrowserInspector taskId={ref.taskId} stepId={ref.browserStepId} />;
      break;
    case 'sandbox':
      body = <SandboxInspector id={ref.sandboxExecId} />;
      break;
    default:
      // a kind from a newer server shows the facts of its span only.
      body = <p className="muted">This kind of span has no inspector yet.</p>;
  }
  return (
    <div className="trace-inspector" data-testid="span-inspector">
      <SpanFacts span={span} usage={ref.kind !== 'model' && ref.kind !== 'review'} />
      {body}
    </div>
  );
}
