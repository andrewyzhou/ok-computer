import { useState, type FormEvent } from 'react';
import type { DocVersionMeta } from '../../../../src/dashboard/docs-types';
import { Button } from '../../ui';
import { docTime, TaintBadge } from './parts';
import { docHref } from './shared';

// the hash that shows the diff from one version to another. the page shows the version "to" with the diff in place
// of its text.
export const diffHref = (id: number, from: number, to: number) => `#/docs/${id}?version=${to}&diff=${from}`;

// a long history shows this many of the newest versions, so the comments stay near the top of the panel.
export const VERSIONS_SHOWN = 5;

// the versions of a doc, newest first, in the details panel. each row opens its version, and each row after the first
// version compares with the one before it. the form compares any two versions, and it starts at the diff on the page
// when one is shown (diffFrom).
export function VersionHistory({
  docId,
  versions,
  current,
  diffFrom,
}: {
  docId: number;
  versions: DocVersionMeta[];
  current: number;
  diffFrom?: number;
}) {
  const [all, setAll] = useState(false);
  // the shown version stays in the list when it is older than the newest few.
  const rows = all || versions.length <= VERSIONS_SHOWN ? versions : versions.filter((meta, index) => index < VERSIONS_SHOWN || meta.version === current);
  return (
    <section className="doc-history" aria-labelledby="doc-history-title">
      <h2 className="doc-panel-title" id="doc-history-title">
        Versions <span className="doc-panel-count">{versions.length}</span>
      </h2>
      <ol className="doc-versions" aria-label="Versions">
        {rows.map((meta) => (
          <li key={meta.version} className={meta.version === current ? 'doc-version is-current' : 'doc-version'}>
            <div className="doc-version-head">
              <a href={docHref(docId, meta.version)} aria-current={meta.version === current ? 'page' : undefined} className="doc-version-link">
                Version {meta.version}
              </a>
              <TaintBadge tainted={meta.taint.length > 0} title={`Written after reading outside content: ${meta.taint.join(', ')}`} />
              {meta.version === current ? <span className="doc-version-current">shown</span> : null}
            </div>
            {meta.note ? <p className="doc-version-note">{meta.note}</p> : null}
            <div className="doc-version-meta">
              <span>{meta.author === 'owner' ? 'you' : 'agent'}</span>
              <span>{docTime(meta.createdAt)}</span>
              <span>{meta.chars.toLocaleString('en-US')} characters</span>
              {meta.runId ? <a href={`#/runs/${encodeURIComponent(meta.runId)}`}>run</a> : null}
            </div>
            {meta.version > 1 ? (
              <a className="doc-version-compare" href={diffHref(docId, meta.version - 1, meta.version)}>
                Compare with previous
              </a>
            ) : null}
          </li>
        ))}
      </ol>
      {rows.length < versions.length ? (
        <Button size="sm" variant="ghost" className="doc-versions-all" onClick={() => setAll(true)}>
          Show all {versions.length} versions
        </Button>
      ) : null}
      {versions.length >= 2 ? (
        <CompareForm key={`${current}-${diffFrom ?? ''}`} docId={docId} versions={versions} current={current} {...(diffFrom !== undefined ? { diffFrom } : {})} />
      ) : null}
    </section>
  );
}

function CompareForm({ docId, versions, current, diffFrom }: { docId: number; versions: DocVersionMeta[]; current: number; diffFrom?: number }) {
  const numbers = versions.map((meta) => meta.version);
  const earlier = numbers.find((number) => number < current) ?? numbers[numbers.length - 1]!;
  const start = diffFrom !== undefined && numbers.includes(diffFrom) ? diffFrom : earlier === current ? numbers[1]! : earlier;
  const [from, setFrom] = useState(start);
  const [to, setTo] = useState(current);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    location.hash = diffHref(docId, from, to);
  };
  return (
    <form className="doc-compare" aria-label="Compare two versions" onSubmit={submit}>
      <label className="select">
        <span>From</span>
        <select value={from} onChange={(event) => setFrom(Number(event.target.value))}>
          {numbers.map((number) => (
            <option key={number} value={number}>
              Version {number}
            </option>
          ))}
        </select>
      </label>
      <label className="select">
        <span>To</span>
        <select value={to} onChange={(event) => setTo(Number(event.target.value))}>
          {numbers.map((number) => (
            <option key={number} value={number}>
              Version {number}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" size="sm">
        Compare
      </Button>
    </form>
  );
}
