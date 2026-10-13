import type {
  BlobBody,
  ModelCallBody,
  ModelCallRow,
  PolicyDecisionRow,
  RunDetail as RunDetailData,
  SubagentLink,
  TimelineItem,
  ToolCallRow,
  ToolCatalog,
} from '../../../src/dashboard/types';
import { useApi } from '../api';
import { Expand, Json, Load, Page, Panel, Status } from '../components';
import { EventView } from '../events';
import { bytes, duration, ms, time, tokens, usd } from '../format';
import { McpMessages } from './Integrations';
import { sessionHref } from './Runs';

function ModelCallBodyView({ id }: { id: number }) {
  const loaded = useApi<ModelCallBody>(`/api/model-calls/${id}`);
  return (
    <Load loaded={loaded}>
      {(body) => (
        <div className="split">
          <div>
            <h3>Request</h3>
            <Json value={body.request} />
          </div>
          <div>
            <h3>Response</h3>
            <Json value={body.response} />
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
          <Json value={catalog.tools} />
        </>
      )}
    </Load>
  );
}

function ModelCallItem({ call, tools }: { call: ModelCallRow; tools: ToolCallRow[] }) {
  return (
    <li className={`step step-model${call.error ? ' is-error' : ''}`}>
      <div className="step-head">
        <strong>model call</strong> {call.provider}/{call.model} <span className="muted">slot {call.slot}</span>
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
          <ModelCallItem key={`m${item.call.id}`} call={item.call} tools={item.tools} />
        ) : (
          <ToolCallItem key={`t${item.call.id}`} call={item.call} />
        ),
      )}
    </ol>
  );
}

function ChildTimeline({ id }: { id: string }) {
  const loaded = useApi<RunDetailData>(`/api/runs/${encodeURIComponent(id)}`);
  return <Load loaded={loaded}>{(detail) => <Timeline items={detail.timeline} className="timeline child" />}</Load>;
}

// a child that never started has no run, for example after a crash between the link and the run.
function ChildView({ link }: { link: SubagentLink }) {
  return (
    <div className="subagent">
      <div className="step-head">
        <strong>sub-agent</strong> {link.profile} {link.status ? <Status value={link.status} /> : <span className="muted">not started</span>}
        <a href={`#/runs/${encodeURIComponent(link.childRunId)}`}>run {link.childRunId.slice(0, 8)}</a>
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
          <p className="muted">
            {bytes(blob.size)}, blob {hash.slice(0, 12)}
          </p>
          <Json value={blob.text} />
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
    <Json value={call.output.content} />
  );
  return (
    <>
      {call.truncated ? (
        <p className="muted">
          The model got a preview and the handle <code>{call.resultHandle}</code>. It can read the full result with
          result_read.
        </p>
      ) : null}
      {call.untrustedSource ? (
        <p className="muted">The result came from {call.untrustedSource}, so the model got it inside an untrusted wrapper.</p>
      ) : null}
      {OUTCOME_NOTES[call.outcome] ? <p className="muted">{OUTCOME_NOTES[call.outcome]}</p> : null}
      {call.rawResultBlob || lost || none ? null : <p className="muted">The model saw the raw result unchanged.</p>}
      <div className="split">
        <div>
          <h3>Raw result</h3>
          {raw}
        </div>
        <div>
          <h3>What the model saw</h3>
          <p className="muted">{bytes(new TextEncoder().encode(call.output.content).length)}</p>
          <Json value={call.output.content} />
        </div>
      </div>
    </>
  );
}

function PolicyView({ policy }: { policy: PolicyDecisionRow }) {
  return (
    <dl className="facts">
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
            on <a href={`#/integrations/${encodeURIComponent(call.serverId)}`}>{call.serverId}</a>
          </span>
        ) : null}
        {call.policy ? (
          <span className="muted">
            <Status value={call.policy.decision} /> by {call.policy.rule}
          </span>
        ) : null}
        {call.riskLevel ? <span className="muted">risk {call.riskLevel}</span> : null}
        {call.tainted ? <Status value="tainted" /> : null}
        {call.resultHandle ? <code>{call.resultHandle}</code> : null}
        <span className="muted">{ms(call.durationMs)}</span>
      </div>
      <Expand label="input">{() => <Json value={call.input} />}</Expand>
      <Expand label="result and what the model saw">{() => <ResultView call={call} />}</Expand>
      {call.policy ? <Expand label="policy decision">{() => <PolicyView policy={call.policy!} />}</Expand> : null}
      {call.serverId ? (
        <Expand label={`${call.mcpMessages.length} json-rpc messages with ${call.serverId}`}>{() => <McpMessages messages={call.mcpMessages} />}</Expand>
      ) : null}
      {call.child ? <ChildView link={call.child} /> : null}
    </li>
  );
}

// the cost of a run counts its own model calls, the reviewer too. its children have their own runs, so their cost
// shows next to it.
function ChildCost({ timeline }: { timeline: TimelineItem[] }) {
  const children = timeline.flatMap((item) => (item.kind === 'model' ? item.tools : [item.call])).flatMap((call) => (call.child ? [call.child] : []));
  if (!children.length) return null;
  const cost = children.reduce((sum, child) => sum + (child.costUsd ?? 0), 0);
  return (
    <span className="muted">
      {' '}
      +{usd(cost)} in {children.length} sub-agent {children.length === 1 ? 'run' : 'runs'}
    </span>
  );
}

export function RunDetail({ id }: { id: string }) {
  const loaded = useApi<RunDetailData>(
    `/api/runs/${encodeURIComponent(id)}`,
    (message) => (message.kind === 'run' && message.run.id === id) || (message.kind === 'event' && message.event.runId === id),
  );
  return (
    <Page title={`Run ${id.slice(0, 8)}`} actions={<a href="#/runs">All runs</a>}>
      <Load loaded={loaded}>
        {({ run, parent, timeline, events }) => (
          <>
            <dl className="facts wide">
              {parent ? (
                <>
                  <dt>Started by</dt>
                  <dd>
                    call {parent.toolCallId} of <a href={`#/runs/${encodeURIComponent(parent.parentRunId)}`}>run {parent.parentRunId.slice(0, 8)}</a>, as the{' '}
                    {parent.profile} sub-agent
                  </dd>
                </>
              ) : null}
              <dt>Status</dt>
              <dd>
                <Status value={run.status} /> {run.error ? <span className="error-text">{run.error}</span> : null}
              </dd>
              <dt>Session</dt>
              <dd>
                <a href={sessionHref(run.sessionKey)}>{run.sessionKey}</a>
              </dd>
              <dt>Trigger</dt>
              <dd>
                {run.trigger}, slot {run.slot}
              </dd>
              <dt>Time</dt>
              <dd>
                {time(run.startedAt)}, {duration(run.startedAt, run.endedAt)}
              </dd>
              <dt>Cost</dt>
              <dd>
                {usd(run.costUsd)} in {run.modelCalls} model calls and {run.toolCalls} tool calls
                <ChildCost timeline={timeline} />
              </dd>
            </dl>
            <Panel title="Timeline">
              <Timeline items={timeline} />
            </Panel>
            <Panel title="Events of this run">
              <div className="log">
                {events.map((event) => (
                  <EventView key={event.id} event={event} />
                ))}
              </div>
            </Panel>
          </>
        )}
      </Load>
    </Page>
  );
}
