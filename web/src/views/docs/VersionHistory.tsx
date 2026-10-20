import { useState, type FormEvent } from 'react';
import type { DocVersionMeta } from '../../../../src/dashboard/docs-types';
import { time } from '../../format';
import { Button } from '../../ui';
import { docHref } from './shared';

// the hash that shows the diff from one version to another. the page shows the version "to" with the diff in place
// of its text.
export const diffHref = (id: number, from: number, to: number) => `#/docs/${id}?version=${to}&diff=${from}`;

// the versions of a doc, newest first, in the details panel. each row opens its version, and each row after the first
// version compares with the one before it. the form compares any two versions.
export function VersionHistory({ docId, versions, current }: { docId: number; versions: DocVersionMeta[]; current: number }) {
  return (
    <div className="doc-history">
      <ol className="doc-versions" aria-label="Versions">
        {versions.map((meta) => (
          <li key={meta.version} className={meta.version === current ? 'doc-version is-current' : 'doc-version'}>
            <div className="doc-version-head">
              <a href={docHref(docId, meta.version)} aria-current={meta.version === current ? 'page' : undefined} className="doc-version-link">
                Version {meta.version}
              </a>
              {meta.taint.length ? (
                <span
                  className="dot tone-warning doc-taint-dot"
                  role="img"
                  aria-label="written after reading outside content"
                  title={meta.taint.join(', ')}
                />
              ) : null}
              {meta.version === current ? <span className="doc-version-current">shown</span> : null}
            </div>
            {meta.note ? <p className="doc-version-note">{meta.note}</p> : null}
            <div className="doc-version-meta">
              <span>{meta.author === 'owner' ? 'you' : 'agent'}</span>
              <span>{time(meta.createdAt)}</span>
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
      {versions.length >= 2 ? <CompareForm key={current} docId={docId} versions={versions} current={current} /> : null}
    </div>
  );
}

function CompareForm({ docId, versions, current }: { docId: number; versions: DocVersionMeta[]; current: number }) {
  const numbers = versions.map((meta) => meta.version);
  const earlier = numbers.find((number) => number < current) ?? numbers[numbers.length - 1]!;
  const [from, setFrom] = useState(earlier === current ? numbers[1]! : earlier);
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
