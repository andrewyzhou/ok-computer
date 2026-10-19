import { useState, type ReactNode } from 'react';
import type { BlobBody, SandboxExecRow, SandboxExecStatus, SandboxLimits } from '../../../../src/dashboard/types';
import { useApi, type Loaded } from '../../api';
import { bytes, ms } from '../../format';
import { Badge, Button, CodeBlock, EmptyState, Facts, Skeleton, type Fact, type Tone } from '../../ui';

// the parts that the sandbox views and the trace inspectors share.

// a status word of the sandbox with its tone. the word shows next to the dot, so the color is never the only signal.
const EXEC_TONE: Record<SandboxExecStatus, Tone> = {
  running: 'info',
  ok: 'good',
  failed: 'critical',
  timeout: 'warning',
  killed: 'serious',
  error: 'critical',
};

export function ExecStatus({ status }: { status: string }) {
  return <Badge tone={EXEC_TONE[status as SandboxExecStatus] ?? 'muted'}>{status}</Badge>;
}

export function limitFacts(limits: SandboxLimits): Fact[] {
  return [
    { label: 'CPUs', value: limits.cpus },
    { label: 'Memory', value: `${limits.memoryMb} MB` },
    { label: 'Time limit', value: ms(limits.timeoutMs) },
    { label: 'Output limit', value: `${bytes(limits.outputBytes)} per stream` },
    { label: 'Processes', value: limits.pids },
  ];
}

// the short facts of one exec, for the details panel of the list and for the sandbox span of a trace.
export function ExecSummary({ exec }: { exec: SandboxExecRow }) {
  return (
    <Facts
      layout="stacked"
      items={[
        { label: 'Status', value: <ExecStatus status={exec.status} /> },
        { label: 'Command', value: <code className="sandbox-mono">{exec.command}</code> },
        { label: 'Image', value: <code className="sandbox-mono">{exec.image}</code> },
        { label: 'Network', value: exec.network === 'none' ? 'none' : `allowlist: ${exec.allowlist.join(', ') || 'empty'}` },
        { label: 'Exit code', value: exec.exitCode ?? '-' },
        { label: 'Duration', value: ms(exec.durationMs) },
        { label: 'Output', value: `stdout ${bytes(exec.stdoutBytes)}, stderr ${bytes(exec.stderrBytes)}${exec.truncated ? ', cut' : ''}` },
        { label: 'Files', value: exec.fileCount },
        exec.runId !== null && {
          label: 'Run',
          value: <a href={`#/runs/${encodeURIComponent(exec.runId)}`}>run {exec.runId.slice(0, 8)}</a>,
        },
      ]}
    />
  );
}

// a 404 is a missing row, not a failure of the page. the server words it as "... not found".
export function isNotFound(error: string): boolean {
  return /not found/i.test(error) || /^404\b/.test(error);
}

// like Load, but a missing row shows as an empty state with the words of the server.
export function LoadRow<T>({ loaded, children, missing }: { loaded: Loaded<T>; children: (data: T) => ReactNode; missing?: ReactNode }) {
  if (loaded.error) {
    if (isNotFound(loaded.error))
      return (
        <EmptyState icon="sandbox" title={`Not found: ${loaded.error}`}>
          {missing}
        </EmptyState>
      );
    return <p className="error-box">Could not load: {loaded.error}</p>;
  }
  if (loaded.data === undefined) return <Skeleton lines={3} />;
  return <>{children(loaded.data)}</>;
}

// the text of a blob, exactly as stored.
export function BlobCode({ hash, label }: { hash: string; label: string }) {
  const loaded = useApi<BlobBody>(`/api/blobs/${encodeURIComponent(hash)}`);
  return <LoadRow loaded={loaded}>{(blob) => <CodeBlock label={`${label}, blob ${hash.slice(0, 12)}, ${blob.mime}`} text={blob.text} />}</LoadRow>;
}

// a blob loads only when the owner asks, because the full output can be large.
export function BlobOnDemand({ hash, label, button }: { hash: string; label: string; button: string }) {
  const [open, setOpen] = useState(false);
  if (open) return <BlobCode hash={hash} label={label} />;
  return (
    <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
      {button}
    </Button>
  );
}
