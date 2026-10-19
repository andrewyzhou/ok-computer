import { useRef } from 'react';
import type { SandboxEgress, SandboxExecDetail, SandboxFile, SandboxPolicyView } from '../../../../src/dashboard/types';
import { useApi } from '../../api';
import { bytes, ms, time } from '../../format';
import type { RouteProps } from '../../routes';
import { ButtonLink, CodeBlock, Facts, Page, Section, Status, Table, type Column } from '../../ui';
import { BlobOnDemand, ExecStatus, FileContent, limitFacts, LoadRow } from './parts';
import './sandbox.css';

// the detail route gives at most this many bytes of each stream, as DETAIL_TEXT_BYTES in src/sandbox/limits.ts. the
// cut moves back to the start of a character, so a cut text can be up to 3 bytes shorter.
const DETAIL_TEXT_BYTES = 64 * 1024;

// the text of a stream is cut in the page when it is at the limit of the detail route and the blob kept more of it.
// the blob holds the first outputBytes of the stream, and the redaction can make it a little shorter than that.
function cutInPage(text: string | null, total: number, outputBytes: number): boolean {
  const shown = text === null ? 0 : new TextEncoder().encode(text).length;
  return text !== null && shown > DETAIL_TEXT_BYTES - 4 && Math.min(total, outputBytes) > shown;
}

function Output({ label, text, blob, total, outputBytes, truncated }: { label: string; text: string | null; blob: string | null; total: number; outputBytes: number; truncated: boolean }) {
  const cut = cutInPage(text, total, outputBytes);
  return (
    <div className="sandbox-output">
      {text === null ? <p className="muted">{label}: no output.</p> : <CodeBlock label={label} text={text} />}
      {cut ? (
        <p className="sandbox-note" role="note">
          This page shows the first {bytes(DETAIL_TEXT_BYTES)} of {label}. The blob store holds {bytes(Math.min(total, outputBytes))}.
        </p>
      ) : null}
      {(cut || truncated) && blob ? <BlobOnDemand hash={blob} label={truncated ? `kept ${label}` : `full ${label}`} button={truncated ? `Load the kept ${label}` : `Load the full ${label}`} /> : null}
    </div>
  );
}

const FILE_COLUMNS: Array<Column<SandboxFile>> = [
  { key: 'path', header: 'Path', wrap: true, cell: (file) => <code className="sandbox-mono">{file.path}</code> },
  { key: 'size', header: 'Size', align: 'end', cell: (file) => bytes(file.size) },
  { key: 'mime', header: 'Type', hideBelow: 'sm', cell: (file) => file.mime },
  { key: 'blob', header: 'Content', wrap: true, cell: (file) => <FileContent file={file} /> },
];

function Files({ title, files }: { title: string; files: SandboxFile[] }) {
  return (
    <Section title={title}>
      <Table label={title.toLowerCase()} dense columns={FILE_COLUMNS} rows={files} rowKey={(file) => `${file.direction}:${file.path}`} empty={<p className="muted">None.</p>} />
    </Section>
  );
}

// the hosts that the egress proxy let through, and the requests that it refused with the reason.
function Egress({ egress }: { egress: SandboxEgress }) {
  return (
    <Section title="Network">
      <Facts
        layout="stacked"
        items={[
          { label: 'Let through', value: egress.passed.length ? egress.passed.join(', ') : <span className="muted">none</span> },
          {
            label: 'Refused',
            value: egress.refused.length ? (
              <ul className="sandbox-list">
                {egress.refused.map((each, i) => (
                  <li key={i}>
                    <code className="sandbox-mono">{each.target}</code> <span className="muted">{each.reason}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="muted">none</span>
            ),
          },
        ]}
      />
    </Section>
  );
}

// the policy decision of the tool call, the verdict of the reviewer, and the approval of a call with network access.
function Policy({ policy }: { policy: SandboxPolicyView | null }) {
  if (!policy) return null;
  return (
    <Section title="Policy">
      <Facts
        items={[
          { label: 'Decision', value: <Status value={policy.decision} /> },
          { label: 'Rule', value: <code className="sandbox-mono">{policy.rule}</code> },
          { label: 'Reason', value: policy.reason },
          policy.reviewerVerdict !== null && {
            label: 'Reviewer',
            value: (
              <>
                <Status value={policy.reviewerVerdict} /> {policy.reviewerReason ?? ''}
              </>
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
    </Section>
  );
}

function ExecBody({ exec }: { exec: SandboxExecDetail }) {
  const cut = exec.truncated;
  return (
    <>
      <Section title="Command">
        <CodeBlock label={`${exec.language} command`} text={exec.command} />
      </Section>
      {exec.error !== null ? <p className="error-box">{exec.error}</p> : null}
      <Section title="Output">
        {cut ? (
          <p className="sandbox-note" role="note">
            The output went over the limit, so only the first {bytes(exec.limits.outputBytes)} of each stream was kept. The blob store
            holds that first part, and the rest is gone.
          </p>
        ) : null}
        <Output label="stdout" text={exec.stdout} blob={exec.stdoutBlob} total={exec.stdoutBytes} outputBytes={exec.limits.outputBytes} truncated={cut} />
        <Output label="stderr" text={exec.stderr} blob={exec.stderrBlob} total={exec.stderrBytes} outputBytes={exec.limits.outputBytes} truncated={cut} />
      </Section>
      <Section title="Facts">
        <Facts
          items={[
            { label: 'Status', value: <ExecStatus status={exec.status} /> },
            { label: 'Exit code', value: exec.exitCode ?? '-' },
            { label: 'Duration', value: ms(exec.durationMs) },
            { label: 'Language', value: exec.language },
            { label: 'Created', value: time(exec.createdAt) },
            { label: 'Ended', value: exec.endedAt ? time(exec.endedAt) : '-' },
            { label: 'Directory', value: <code className="sandbox-mono">{exec.cwd}</code> },
            { label: 'Image', value: <code className="sandbox-mono">{exec.image}</code> },
            exec.imageId !== null && { label: 'Image id', value: <code className="sandbox-mono">{exec.imageId.slice(0, 19)}</code> },
            exec.containerId !== null && { label: 'Container', value: <code className="sandbox-mono">{exec.containerId.slice(0, 12)}</code> },
            { label: 'Network', value: exec.network === 'none' ? 'none' : `allowlist: ${exec.allowlist.join(', ') || 'empty'}` },
            ...limitFacts(exec.limits),
            exec.sessionKey !== null && { label: 'Session', value: exec.sessionKey },
            exec.toolCallId !== null && { label: 'Tool call', value: <code>{exec.toolCallId}</code> },
            exec.runId !== null && {
              label: 'Run',
              value: (
                <>
                  <a href={`#/runs/${encodeURIComponent(exec.runId)}`}>run {exec.runId.slice(0, 8)}</a>,{' '}
                  <a href={`#/trace/${encodeURIComponent(exec.runId)}`}>its trace</a>
                </>
              ),
            },
          ]}
        />
      </Section>
      <Policy policy={exec.policy} />
      {exec.egress ? <Egress egress={exec.egress} /> : null}
      <Files title="Files in" files={exec.files.filter((file) => file.direction === 'in')} />
      <Files title="Files out" files={exec.files.filter((file) => file.direction === 'out')} />
      {exec.notCollected.length ? (
        <Section title="Not collected">
          <ul className="sandbox-list">
            {exec.notCollected.map((each) => (
              <li key={each.path}>
                <code className="sandbox-mono">{each.path}</code> <span className="muted">{each.reason}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </>
  );
}

export function CodeRunPage({ params }: RouteProps) {
  const execId = params.execId ?? '';
  // a running exec ends with its tool call, so the page reloads on the tool calls of its run.
  const running = useRef<string | null>(null);
  const loaded = useApi<SandboxExecDetail>(
    `/api/sandbox/execs/${encodeURIComponent(execId)}`,
    (message) => running.current !== null && message.kind === 'tool_call' && message.call.runId === running.current,
  );
  running.current = loaded.data?.status === 'running' ? loaded.data.runId : null;
  return (
    <Page title="Code run" subtitle={`#${execId}`} width="full" crumbs={[{ label: 'Sandbox', href: '#/sandbox?tab=code' }]}>
      <LoadRow
        loaded={loaded}
        missing={
          <ButtonLink size="sm" href="#/sandbox?tab=code">
            All code runs
          </ButtonLink>
        }
      >
        {(exec) => <ExecBody exec={exec} />}
      </LoadRow>
    </Page>
  );
}
