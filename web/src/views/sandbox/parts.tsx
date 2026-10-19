import { useEffect, useState, type ReactNode } from 'react';
import type { BlobBody, SandboxExecRow, SandboxExecStatus, SandboxFile, SandboxLimits } from '../../../../src/dashboard/types';
import { apiUrl, useApi, type Loaded } from '../../api';
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
        { label: 'Language', value: exec.language },
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

// the server shows these types in the page, and every other file downloads, so a file that the code made never runs
// as a page of the dashboard.
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// a file whose type says text can show its text in the page. the server picks the store by the bytes, not by the type,
// so the type only decides if the page offers the text.
function textual(mime: string): boolean {
  return mime.startsWith('text/') || /json|xml|javascript|yaml|csv|charset=utf-8/.test(mime);
}

// the text of a file of an exec. it loads through the files route, which reads both stores, so a text file with a nul
// byte or bad utf-8, which is in the byte store, loads too. a bad byte shows as the replacement character.
function FileText({ file, label }: { file: SandboxFile; label: string }) {
  const [loaded, setLoaded] = useState<{ text?: string; error?: string }>({});
  useEffect(() => {
    let current = true;
    fetch(apiUrl(`/api/sandbox/files/${encodeURIComponent(file.blob)}`))
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `${response.status} ${response.statusText}`);
        }
        return new TextDecoder().decode(await response.arrayBuffer());
      })
      .then(
        (text) => current && setLoaded({ text }),
        (err: Error) => current && setLoaded({ error: err.message }),
      );
    return () => {
      current = false;
    };
  }, [file.blob]);
  return (
    <LoadRow loaded={{ ...(loaded.text !== undefined ? { data: loaded.text } : {}), ...(loaded.error !== undefined ? { error: loaded.error } : {}), reload: () => undefined }}>
      {(text) => <CodeBlock label={`${label}, blob ${file.blob.slice(0, 12)}, ${file.mime}`} text={text} />}
    </LoadRow>
  );
}

// the content of a file of an exec. GET /api/sandbox/files/:hash gives its bytes: a raster image shows, and any other
// file downloads. a text file can also show its text in the page.
export function FileContent({ file }: { file: SandboxFile }) {
  const [open, setOpen] = useState(false);
  const url = apiUrl(`/api/sandbox/files/${encodeURIComponent(file.blob)}`);
  if (INLINE.has(file.mime)) return <img className="sandbox-file-image" alt={file.path} src={url} />;
  return (
    <span className="sandbox-file">
      {textual(file.mime) ? (
        open ? (
          <FileText file={file} label={file.path} />
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
            Load
          </Button>
        )
      ) : null}
      <a href={url} download>
        Download
      </a>
    </span>
  );
}
