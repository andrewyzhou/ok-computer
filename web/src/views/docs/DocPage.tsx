import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocDetail, DocLink } from '../../../../src/dashboard/docs-types';
import { useApi } from '../../api';
import type { RouteProps } from '../../routes';
import { useShell } from '../../shell/context';
import { Badge, Button, ButtonLink, DetailsPanel, EmptyState, isNotFound, Page, Skeleton } from '../../ui';
import { DocComments } from './Comments';
import { DiffView } from './DiffView';
import { DocAnchor, Markdown, withoutTitle } from './Markdown';
import { docTime, ErrorBlock } from './parts';
import { docApi, docExportHref, docHref, docIdOf, kindLabel } from './shared';
import { VersionHistory } from './VersionHistory';
import './reader.css';

// one doc at #/docs/:id: the rendered markdown of a version, the version history with a diff, the links, the export
// and the owner's comments (DocComments of Comments.tsx). ?version=N picks a version, and ?diff=<from> shows the diff
// from that version to the shown one in place of the text.

// the quote of a comment is at most this long, as the api allows.
const QUOTE_LIMIT = 500;
// the taint banner names this many sources, and counts the rest.
const TAINT_SHOWN = 5;
// the shell already starts the breadcrumb with the docs group, which links to the list. a crumb of the list here
// would read Docs / Docs.
const NO_CRUMBS: never[] = [];

// the page of a doc or a version that is not there, with a button to the next step, as the empty states of the other
// views have.
function Missing({ what, href, label }: { what: 'doc' | 'version'; href: string; label: string }) {
  return (
    <EmptyState
      icon="docs"
      title={`This ${what} does not exist.`}
      action={
        <ButtonLink href={href} size="sm">
          {label}
        </ButtonLink>
      }
    />
  );
}

// a query value that is a positive whole number, else undefined. null means that the query does not have it.
function versionOf(value: string | null): number | undefined | null {
  if (value === null) return null;
  return /^[1-9]\d{0,8}$/.test(value) ? Number(value) : undefined;
}

function TaintBanner({ sources }: { sources: string[] }) {
  const shown = sources.slice(0, TAINT_SHOWN);
  const more = sources.length - shown.length;
  return (
    <div className="doc-banner doc-banner-warning" role="note">
      <p>
        <strong>The agent wrote this after reading outside content.</strong> It can repeat text from those sources, so check it before you act on it.
      </p>
      <ul className="doc-taint-sources">
        {shown.map((source, index) => (
          <li key={index}>{source}</li>
        ))}
      </ul>
      {more > 0 ? <p className="muted">and {more} more</p> : null}
    </div>
  );
}

// the links of a version. a tainted version gets the same checks as the links in its text (heldReason of
// Markdown.tsx).
function Links({ links, tainted }: { links: DocLink[]; tainted: boolean }) {
  if (!links.length) return null;
  return (
    <section className="doc-links" aria-label="Links">
      <h2 className="doc-links-title">Links</h2>
      <ul>
        {links.map((link, index) => (
          <li key={index}>
            <DocAnchor href={link.href} tainted={tainted}>
              {link.label}
            </DocAnchor>
          </li>
        ))}
      </ul>
    </section>
  );
}

// the text that the owner selected inside the article, for the quote of a comment. a selection that reaches outside
// the article gives an empty text.
function selectionIn(article: HTMLElement | null): string {
  const selection = globalThis.getSelection?.();
  if (!article || !selection || selection.rangeCount === 0 || selection.isCollapsed) return '';
  const inside = (node: Node | null) => node !== null && article.contains(node);
  if (!inside(selection.anchorNode) || !inside(selection.focusNode)) return '';
  return selection.toString().trim().slice(0, QUOTE_LIMIT);
}

export function DocPage({ params, query }: RouteProps) {
  const id = docIdOf(params.id);
  const asked = versionOf(query.get('version'));
  const diffFrom = versionOf(query.get('diff'));
  const version = typeof asked === 'number' ? asked : undefined;
  const shell = useShell();
  const article = useRef<HTMLDivElement | null>(null);
  const [selection, setSelection] = useState('');
  const readSelection = useCallback(() => setSelection(selectionIn(article.current)), []);

  // a new version from the agent comes with a run, so the newest version loads again after each run message. an
  // old version never changes, so it does not load again.
  const newestRef = useRef(true);
  const loaded = useApi<DocDetail>(
    id !== undefined && asked !== undefined ? docApi(id, version) : null,
    (message) => message.kind === 'run' && newestRef.current,
  );
  const detail = loaded.data;
  newestRef.current = version === undefined || (detail !== undefined && detail.version.version === detail.doc.version);
  // a quote belongs to the version that the owner selected it in.
  const shownVersion = detail?.version.version;
  useEffect(() => setSelection(''), [shownVersion]);

  if (id === undefined)
    return (
      <Page title="Doc" crumbs={NO_CRUMBS}>
        <Missing what="doc" href="#/docs" label="Go to the docs" />
      </Page>
    );

  if (asked === undefined || (loaded.error && isNotFound(loaded.error))) {
    const missingVersion = asked === undefined || /version/i.test(loaded.error ?? '');
    return (
      <Page title="Doc" crumbs={NO_CRUMBS}>
        {missingVersion ? <Missing what="version" href={docHref(id)} label="Read the newest version" /> : <Missing what="doc" href="#/docs" label="Go to the docs" />}
      </Page>
    );
  }

  if (loaded.error)
    return (
      <Page title="Doc" crumbs={NO_CRUMBS}>
        <ErrorBlock what="the doc" error={loaded.error} onRetry={loaded.reload} back={{ href: '#/docs', label: 'Back to docs' }} />
      </Page>
    );

  if (!detail)
    return (
      <Page title="Doc" crumbs={NO_CRUMBS}>
        <div className="doc-reader">
          <Skeleton lines={8} label="Loading the doc…" />
        </div>
      </Page>
    );

  const { doc, version: shown, versions, comments } = detail;
  const old = shown.version !== doc.version;
  const tainted = shown.taint.length > 0;
  return (
    <Page
      title={shown.title}
      crumbs={NO_CRUMBS}
      subtitle={
        <span className="doc-subtitle">
          <Badge tone="muted">{kindLabel(shown.kind)}</Badge>
          <span>
            version {shown.version} of {doc.version}
          </span>
          {/* an old version shows its own time, not the time of the newest one. */}
          <span>{old ? `written ${docTime(shown.createdAt)}` : `updated ${docTime(doc.updatedAt)}`}</span>
        </span>
      }
      actions={
        <>
          {old ? (
            <ButtonLink href={docHref(id)} size="sm" variant="ghost" className="doc-newest-action">
              Newest version
            </ButtonLink>
          ) : null}
          <ButtonLink href={docExportHref(id, version)} download size="sm">
            Export .md
          </ButtonLink>
        </>
      }
    >
      <div className="doc-reader">
        {old ? (
          <div className="doc-banner" role="note">
            <p>
              You are reading version {shown.version} of {doc.version}. <a href={docHref(id)}>Read the newest version</a>
            </p>
          </div>
        ) : null}
        {shown.taint.length ? <TaintBanner sources={shown.taint} /> : null}
        {typeof diffFrom === 'number' ? (
          <DiffView docId={id} from={diffFrom} to={shown.version} closeHref={docHref(id, version)} />
        ) : (
          <div className="doc-article" ref={article} onMouseUp={readSelection} onKeyUp={readSelection}>
            <Markdown text={withoutTitle(shown.body, shown.title)} tainted={tainted} />
          </div>
        )}
        <Links links={shown.links} tainted={tainted} />
        <div className="doc-panel-button">
          <Button icon="panel" onClick={() => shell?.openDetails()}>
            Versions and comments
          </Button>
        </div>
      </div>
      <DetailsPanel title="Versions and comments">
        <VersionHistory docId={id} versions={versions} current={shown.version} {...(typeof diffFrom === 'number' ? { diffFrom } : {})} />
        <DocComments doc={doc} version={shown.version} comments={comments} selection={selection} onAdded={loaded.reload} />
      </DetailsPanel>
    </Page>
  );
}
