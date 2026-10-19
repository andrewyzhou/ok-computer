import type {
  BlobBody,
  ModelCallBody,
  ModelCallRow,
  PolicyDecisionRow,
  RunDetail as RunDetailData,
  StreamMessage,
  SubagentLink,
  TimelineItem,
  ToolCallRow,
  ToolCatalog,
} from '../../../src/dashboard/types';
import { useRef } from 'react';
import { useApi } from '../api';
import { Expand, Load, Status } from '../components';
import { EventView } from '../events';
import { bytes, duration, ms, time, tokens, usd } from '../format';
import { useDevMode } from '../shell/prefs';
import { ButtonLink, CodeBlock, DetailsPanel, EmptyState, Facts, Page, Section } from '../ui';
import { GoogleRequests } from './Google';
import { McpMessages } from './Integrations';
import { runHref, sessionHref } from './Runs';
import './dev.css';

// a body of the server as it is stored. a text stays as it is, and other json gets two spaces of indent.
const asText = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));

function ModelCallBodyView({ id }: { id: number }) {
  const loaded = useApi<ModelCallBody>(`/api/model-calls/${id}`);
  return (
    <Load loaded={loaded}>
      {(body) => (
        <div className="run-split">
          <div>
            <h3>Request</h3>
            <CodeBlock text={asText(body.request)} label="request" />
          </div>
          <div>
            <h3>Response</h3>
            <CodeBlock text={asText(body.response)} label="response" />
          </div>
        </div>
      )}
    </Load>
  );
}

function CatalogView({ hash }: { hash: string }) {
  const loaded = useApi<ToolCatalog>(`/api/tool-catalogs/${hash}`);
  return (
    <Load loaded={loaded}>
      {(catalog) => (
        <>
          <p className="muted">
            Catalog {hash.slice(0, 12)}, first offered {time(catalog.createdAt)}
          </p>
          <CodeBlock text={asText(catalog.tools)} label="tools" />
        </>
      )}
    </Load>
  );
}

function ModelCallItem({ call, tools, reviews = [] }: { call: ModelCallRow; tools: ToolCallRow[]; reviews?: ModelCallRow[] }) {
  return (
    <li className={`step step-model${call.error ? ' is-error' : ''}`}>
      <div className="step-head">
        <strong>model call</strong>{' '}
        <span className="run-model">
          {call.provider}/{call.model}
        </span>{' '}
        <span className="muted">slot {call.slot}</span>
        {call.error ? <Status value="failed" /> : <span className="muted">{call.stopReason}</span>}
      </div>
      <div className="metrics">
        <span>in {tokens(call.inputTokens)}</span>
        <span>out {tokens(call.outputTokens)}</span>
        <span>cache read {tokens(call.cacheReadTokens)}</span>
        <span>cache write {tokens(call.cacheWriteTokens)}</span>
        <span>{usd(call.costUsd)}</span>
        <span>{ms(call.latencyMs)}</span>
        <span className="muted">{time(call.createdAt)}</span>
      </div>
      {call.error ? <p className="error-text">{call.error}</p> : null}
      {call.toolCatalogHash ? (
        <Expand label={`${call.toolCount ?? '?'} tools offered (catalog ${call.toolCatalogHash.slice(0, 8)})`}>
          {() => <CatalogView hash={call.toolCatalogHash!} />}
        </Expand>
      ) : null}
      <Expand label="full request and response">{() => <ModelCallBodyView id={call.id} />}</Expand>
      {reviews.length ? (
        <Expand label={`${reviews.length} reviewer calls with no verdict`}>
          {() => (
            <ul>
              {reviews.map((review) => (
                <li key={review.id}>
                  {review.provider}/{review.model}, slot {review.slot}, {usd(review.costUsd)}, {ms(review.latencyMs)}
                  {review.error ? <span className="error-text"> {review.error}</span> : null}
                  <Expand label="what the reviewer saw and answered">{() => <ModelCallBodyView id={review.id} />}</Expand>
                </li>
              ))}
            </ul>
          )}
        </Expand>
      ) : null}
      {tools.length ? (
        <ol className="timeline nested">
          {tools.map((tool) => (
            <ToolCallItem key={tool.id} call={tool} />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

// the run page and the child run inside a delegate call use the same timeline.
function Timeline({ items, className = 'timeline' }: { items: TimelineItem[]; className?: string }) {
  return (
    <ol className={className}>
      {items.map((item) =>
        item.kind === 'model' ? (
          <ModelCallItem key={`m${item.call.id}`} call={item.call} tools={item.tools} reviews={item.reviews} />
        ) : (
          <ToolCallItem key={`t${item.call.id}`} call={item.call} />
        ),
      )}
    </ol>
  );
}

// a message about one of the runs, or about an event of one of them.
const aboutRuns = (ids: ReadonlySet<string>) => (message: StreamMessage) =>
  (message.kind === 'run' && ids.has(message.run.id)) || (message.kind === 'event' && ids.has(message.event.runId ?? ''));

// the parent writes no events while its delegate call waits, so the child timeline follows the events of the child.
function ChildTimeline({ id }: { id: string }) {
  const loaded = useApi<RunDetailData>(`/api/runs/${encodeURIComponent(id)}`, aboutRuns(new Set([id])));
  return <Load loaded={loaded}>{(detail) => <Timeline items={detail.timeline} className="timeline child" />}</Load>;
}

// a child that never started has no run, for example after a crash between the link and the run.
function ChildView({ link }: { link: SubagentLink }) {
  return (
    <div className="subagent">
      <div className="step-head">
        <strong>sub-agent</strong> {link.profile} {link.status ? <Status value={link.status} /> : <span className="muted">not started</span>}
        <a className="dev-id" href={runHref(link.childRunId)}>
          run {link.childRunId.slice(0, 8)}
        </a>
        <span className="muted">{usd(link.costUsd)}</span>
      </div>
      <Expand label="timeline of the sub-agent">{() => <ChildTimeline id={link.childRunId} />}</Expand>
    </div>
  );
}

function BlobText({ hash }: { hash: string }) {
  const loaded = useApi<BlobBody>(`/api/blobs/${hash}`);
  return (
    <Load loaded={loaded}>
      {(blob) => (
        <>
          <p className="muted small">
            {bytes(blob.size)}, blob <code className="dev-id">{hash.slice(0, 12)}</code>
          </p>
          <CodeBlock text={blob.text} label="raw result" />
        </>
      )}
    </Load>
  );
}

// these outcomes need a sentence, because the model saw a note and not the result of the tool.
const OUTCOME_NOTES: Record<string, string> = {
  abandoned: 'The run stopped while the tool ran. The model was told that the effect is unknown.',
  late: 'The run stopped while the tool ran, and the tool finished later. The raw result is the late result. The model saw the note, and the late result came to the session as a system event.',
  interrupted: 'The app stopped while the tool ran. The model got a note that the effect is unknown.',
  unsent: 'The integration did not send the call, so the tool did not run. An approved call waits for the owner again.',
};

// these outcomes have no result of the tool. the model view holds the note of the caller.
const NO_RESULT = new Set(['abandoned', 'interrupted']);

// the raw result is what the tool gave. the model view is the exact text that the model got, after the wrapper of
// untrusted text and the cut to a preview. a preview, a wrapped text and a late result always get a blob, so such a
// row without a blob lost its raw text when the blob write failed. its model view is not the raw result.
function ResultView({ call }: { call: ToolCallRow }) {
  const lost = !call.rawResultBlob && (call.truncated || call.untrustedSource !== null || call.outcome === 'late');
  const none = !call.rawResultBlob && NO_RESULT.has(call.outcome);
  const raw = call.rawResultBlob ? (
    <BlobText hash={call.rawResultBlob} />
  ) : lost ? (
    <p className="muted">The raw result was not stored, because its blob write failed. The log has the error.</p>
  ) : none ? (
    <p className="muted">The tool gave no result.</p>
  ) : (
    <CodeBlock text={call.output.content} label="raw result" />
  );
  return (
    <>
      {call.truncated ? (
        <p className="muted">
          The model got a preview and the handle <code>{call.resultHandle}</code>. It can read the full result with result_read.
        </p>
      ) : null}
      {call.untrustedSource ? <p className="muted">The result came from {call.untrustedSource}, so the model got it inside an untrusted wrapper.</p> : null}
      {OUTCOME_NOTES[call.outcome] ? <p className="muted">{OUTCOME_NOTES[call.outcome]}</p> : null}
      {call.rawResultBlob || lost || none ? null : <p className="muted">The model saw the raw result unchanged.</p>}
      <div className="run-split">
        <div>
          <h3>Raw result</h3>
          {raw}
        </div>
        <div>
          <h3>What the model saw</h3>
          <CodeBlock text={call.output.content} label="model input" />
        </div>
      </div>
    </>
  );
}

function PolicyView({ policy }: { policy: PolicyDecisionRow }) {
  return (
    <dl className="facts run-policy">
      <dt>Decision</dt>
      <dd>
        <Status value={policy.decision} /> by {policy.rule}
      </dd>
      <dt>Reason</dt>
      <dd>{policy.reason}</dd>
      {policy.taint.length ? (
        <>
          <dt>Taint</dt>
          <dd>
            {policy.taint.map((each) => (
              <div key={each.source}>
                {each.source}, read by {each.toolName} at {time(each.at)}
                {each.runId ? (
                  <>
                    {' '}
                    in <a href={`#/runs/${encodeURIComponent(each.runId)}`}>run {each.runId.slice(0, 8)}</a>
                  </>
                ) : null}
              </div>
            ))}
          </dd>
        </>
      ) : null}
      {policy.reviewerVerdict ? (
        <>
          <dt>Reviewer</dt>
          <dd>
            <Status value={policy.reviewerVerdict} /> {policy.reviewerReason}
          </dd>
        </>
      ) : null}
      {policy.reviewerCall ? (
        <>
          <dt>Reviewer call</dt>
          <dd>
            {policy.reviewerCall.provider}/{policy.reviewerCall.model}, slot {policy.reviewerCall.slot}, in {tokens(policy.reviewerCall.inputTokens)}, out{' '}
            {tokens(policy.reviewerCall.outputTokens)}, {usd(policy.reviewerCall.costUsd)}, {ms(policy.reviewerCall.latencyMs)}
            {policy.reviewerCall.error ? <span className="error-text"> {policy.reviewerCall.error}</span> : null}
            <Expand label="what the reviewer saw and answered">{() => <ModelCallBodyView id={policy.reviewerCall!.id} />}</Expand>
          </dd>
        </>
      ) : null}
      {policy.approvalId !== null ? (
        <>
          <dt>Approval</dt>
          <dd>
            <a href="#/approvals">#{policy.approvalId}</a> {policy.approvalStatus ? <Status value={policy.approvalStatus} /> : null}
          </dd>
        </>
      ) : null}
    </dl>
  );
}

function ToolCallItem({ call }: { call: ToolCallRow }) {
  return (
    <li className={`step step-tool${call.isError ? ' is-error' : ''}`}>
      <div className="step-head">
        <strong>tool call</strong> {call.name} <Status value={call.outcome} />
        {call.serverId ? (
          <span className="muted">
            on <a href={call.source === 'google' ? '#/google' : `#/integrations/${encodeURIComponent(call.serverId)}`}>{call.serverId}</a>
          </span>
        ) : null}
        {call.policy ? (
          <span className="muted">
            <Status value={call.policy.decision} /> by {call.policy.rule}
          </span>
        ) : null}
        {call.riskLevel ? <span className="muted">risk {call.riskLevel}</span> : null}
        {call.tainted ? <Status value="tainted" /> : null}
        {call.resultHandle ? <code className="dev-id">{call.resultHandle}</code> : null}
        <span className="muted">{ms(call.durationMs)}</span>
      </div>
      <Expand label="input">{() => <CodeBlock text={asText(call.input)} label="input" />}</Expand>
      <Expand label="result and what the model saw">{() => <ResultView call={call} />}</Expand>
      {call.policy ? <Expand label="policy decision">{() => <PolicyView policy={call.policy!} />}</Expand> : null}
      {call.source === 'google' ? (
        <Expand label="http requests to google">
          {() => <GoogleRequests query={`runId=${encodeURIComponent(call.runId)}&toolCallId=${encodeURIComponent(call.toolCallId)}`} />}
        </Expand>
      ) : call.serverId ? (
        <Expand label={`${call.mcpMessages.length} json-rpc messages with ${call.serverId}`}>{() => <McpMessages messages={call.mcpMessages} />}</Expand>
      ) : null}
      {call.child ? <ChildView link={call.child} /> : null}
    </li>
  );
}

const childrenOf = (timeline: TimelineItem[]) =>
  timeline.flatMap((item) => (item.kind === 'model' ? item.tools : [item.call])).flatMap((call) => (call.child ? [call.child] : []));

// the cost of a run counts its own model calls, the reviewer too. its children have their own runs, so their cost
// shows next to it.
function ChildCost({ timeline }: { timeline: TimelineItem[] }) {
  const children = childrenOf(timeline);
  if (!children.length) return null;
  const cost = children.reduce((sum, child) => sum + (child.costUsd ?? 0), 0);
  return (
    <span className="muted">
      {' '}
      +{usd(cost)} in {children.length} sub-agent {children.length === 1 ? 'run' : 'runs'}
    </span>
  );
}

// the facts of the run sit in the details panel, so the timeline gets the width of the main area.
function RunPanel({ detail }: { detail: RunDetailData }) {
  const { run, parent, timeline } = detail;
  const devMode = useDevMode();
  return (
    <DetailsPanel title="Run">
      <Facts
        layout="stacked"
        items={[
          parent && {
            label: 'Started by',
            value: (
              <>
                call <code className="dev-id">{parent.toolCallId}</code> of <a href={runHref(parent.parentRunId)}>run {parent.parentRunId.slice(0, 8)}</a>, as
                the {parent.profile} sub-agent
              </>
            ),
          },
          { label: 'Run id', value: <code className="dev-id">{run.id}</code> },
          {
            label: 'Status',
            value: (
              <>
                <Status value={run.status} /> {run.error ? <span className="error-text">{run.error}</span> : null}
              </>
            ),
          },
          { label: 'Session', value: <a href={sessionHref(run.sessionKey)}>{run.sessionKey}</a> },
          {
            label: 'Trigger',
            value: (
              <>
                {run.trigger}, slot {run.slot}
              </>
            ),
          },
          {
            label: 'Time',
            value: (
              <>
                {time(run.startedAt)}, {duration(run.startedAt, run.endedAt)}
              </>
            ),
          },
          {
            label: 'Cost',
            value: (
              <>
                {usd(run.costUsd)} in {run.modelCalls} model calls and {run.toolCalls} tool calls
                <ChildCost timeline={timeline} />
              </>
            ),
          },
        ]}
      />
      {/* a phone has no room for these links in the header, so the panel has them too. */}
      <div className="dev-panel-actions dev-narrow-only">
        {devMode ? (
          <ButtonLink href={`#/logs?runId=${encodeURIComponent(run.id)}`} size="sm" icon="log">
            Logs of this run
          </ButtonLink>
        ) : null}
        <ButtonLink href="#/runs" size="sm" icon="run">
          All runs
        </ButtonLink>
      </div>
    </DetailsPanel>
  );
}

export function RunDetail({ id }: { id: string; query?: URLSearchParams }) {
  const devMode = useDevMode();
  // the status and the cost of each child show on this page too, and they change while the parent waits.
  // a delegate call can wait for the reviewer before its child starts, and the parent writes no event until the child
  // ends. so a running page also loads again when a new child run of any parent starts.
  const runs = useRef<ReadonlySet<string>>(new Set());
  const running = useRef(false);
  const loaded = useApi<RunDetailData>(
    `/api/runs/${encodeURIComponent(id)}`,
    (message) => aboutRuns(runs.current)(message) || (running.current && message.kind === 'run' && message.run.trigger === 'subagent'),
  );
  runs.current = new Set([id, ...childrenOf(loaded.data?.timeline ?? []).map((child) => child.childRunId)]);
  running.current = loaded.data?.run.status === 'running';
  return (
    <Page
      title={`Run ${id.slice(0, 8)}`}
      crumbs={[{ label: 'Runs', href: '#/runs' }]}
      width="full"
      actions={
        <>
          {devMode ? (
            <>
              <a className="run-logs-link dev-wide-only" href={`#/logs?runId=${encodeURIComponent(id)}`}>
                Logs of this run
              </a>
              <ButtonLink href={`#/trace/${encodeURIComponent(id)}`} size="sm" icon="trace">
                Trace
              </ButtonLink>
            </>
          ) : null}
          <ButtonLink href="#/runs" size="sm" variant="ghost" className="dev-wide-only">
            All runs
          </ButtonLink>
        </>
      }
    >
      <Load loaded={loaded}>
        {(detail) => (
          <>
            <RunPanel detail={detail} />
            <Section title="Timeline" description={`${detail.timeline.length} steps, oldest first.`}>
              {detail.timeline.length ? <Timeline items={detail.timeline} /> : <EmptyState icon="run" title="This run made no model or tool call." />}
            </Section>
            {detail.run.trigger === 'poll' ? (
              <Section title="Requests of this poll">
                <GoogleRequests query={`runId=${encodeURIComponent(detail.run.id)}`} />
              </Section>
            ) : null}
            <Section title="Events of this run">
              {detail.events.length ? (
                <div className="log">
                  {detail.events.map((event) => (
                    <EventView key={event.id} event={event} />
                  ))}
                </div>
              ) : (
                <EmptyState icon="log" title="This run wrote no events." />
              )}
            </Section>
          </>
        )}
      </Load>
    </Page>
  );
}
