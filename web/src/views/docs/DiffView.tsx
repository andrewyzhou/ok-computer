import type { DocDiff, DocDiffLine } from '../../../../src/dashboard/docs-types';
import { useApi } from '../../api';
import { Button, isNotFound, Skeleton } from '../../ui';
import { docDiffApi } from './shared';

// the diff between two versions of a doc, in place of its text. it is a unified diff: each hunk has its header, the
// line numbers of both versions sit in two columns, and each added or removed line has a + or − mark next to its
// color, so the meaning never rests on the color alone. the lines are model text and show as plain text.

const MINUS = '−';

const MARK: Record<DocDiffLine['op'], string> = {
  same: ' ',
  add: '+',
  del: MINUS,
};
const SPOKEN: Record<DocDiffLine['op'], string> = {
  same: '',
  add: 'added: ',
  del: 'removed: ',
};

export function DiffView({ docId, from, to, closeHref }: { docId: number; from: number; to: number; closeHref: string }) {
  const loaded = useApi<DocDiff>(docDiffApi(docId, from, to));
  const diff = loaded.data;
  const close = (
    <a className="doc-diff-close" href={closeHref}>
      Close diff
    </a>
  );
  if (loaded.error)
    return (
      <section className="doc-diff" aria-label="Diff">
        <div className="doc-diff-head">
          <p className="doc-diff-summary">
            Changes from version {from} to version {to}
          </p>
          {close}
        </div>
        {isNotFound(loaded.error) ? (
          <p className="muted">That version does not exist.</p>
        ) : (
          <div className="doc-error">
            <p className="error-box">Could not load the diff: {loaded.error}</p>
            <Button size="sm" onClick={loaded.reload}>
              Try again
            </Button>
          </div>
        )}
      </section>
    );
  if (!diff) return <Skeleton lines={6} label="Loading the diff…" />;
  return (
    <section className="doc-diff" aria-label="Diff">
      <div className="doc-diff-head">
        <p className="doc-diff-summary">
          Changes from version {diff.from} to version {diff.to}: <span className="doc-diff-added">+{diff.added}</span>{' '}
          <span className="doc-diff-removed">
            {MINUS}
            {diff.removed}
          </span>{' '}
          lines
        </p>
        {close}
      </div>
      {diff.title ? (
        <p className="doc-diff-title">
          Title: {diff.title.from} → {diff.title.to}
        </p>
      ) : null}
      {diff.coarse ? (
        <p className="doc-diff-note">
          The doc is too long to compare line by line, so the diff shows the whole old text removed and the whole new text added.
        </p>
      ) : null}
      {diff.hunks.length === 0 ? (
        <p className="muted">These versions have the same text.</p>
      ) : (
        <div className="doc-hunks">
          {diff.hunks.map((hunk, index) => (
            <div key={index} className="doc-hunk">
              <div className="doc-hunk-head">
                @@ {MINUS}
                {hunk.fromStart},{hunk.fromLines} +{hunk.toStart},{hunk.toLines} @@
              </div>
              <div className="doc-hunk-scroll">
                <table className="doc-diff-lines">
                  <tbody>
                    {hunk.lines.map((line, lineIndex) => (
                      <tr key={lineIndex} className={`doc-line doc-line-${line.op}`}>
                        <td className="doc-ln" aria-label={line.fromLine === null ? undefined : `version ${diff.from} line ${line.fromLine}`}>
                          {line.fromLine ?? ''}
                        </td>
                        <td className="doc-ln" aria-label={line.toLine === null ? undefined : `version ${diff.to} line ${line.toLine}`}>
                          {line.toLine ?? ''}
                        </td>
                        <td className="doc-mark" aria-hidden="true">
                          {MARK[line.op]}
                        </td>
                        <td className="doc-line-text">
                          {SPOKEN[line.op] ? <span className="sr-only">{SPOKEN[line.op]}</span> : null}
                          {line.text}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
