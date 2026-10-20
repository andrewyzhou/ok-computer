import type { DocDetail } from '../../../../src/dashboard/docs-types';
import { useApi } from '../../api';
import { time } from '../../format';
import { Icon } from '../../icons';
import { isNotFound } from '../../ui';
import { docApi, docHref, docIdOf, kindLabel } from './shared';
import './link-card.css';

// the card of a doc link in the chat. an agent reply that links to a doc (a #/docs/<id> link, alone or after the
// dashboard url) gets one card for each doc under its text, with the title, the kind and the version, so the owner
// opens the doc and the chat stays short. ChatView renders it under each agent message and each live reply.

// a reply names a few docs at most. more cards would push the next message far down.
export const MAX_CARDS = 3;

// the link of a doc: an optional http(s) origin, the hash of the doc and an optional version. the id must not go on
// with a digit, a letter or a slash, so #/docs/12x and #/docs/1/edit are not links of a doc. an id with a leading
// zero is not one either: [1-9] cannot match its first digit.
const DOC_LINK = /(?:https?:\/\/[^\s/#?"'<>]+)?#\/docs\/([1-9]\d*)(?:\?version=([1-9]\d*))?(?![\w/])/g;

export interface DocLinkRef {
  id: number;
  version?: number;
}

// the docs that a text links to, each once, in the order of their first link.
export function docLinksIn(text: string): DocLinkRef[] {
  const found = new Map<number, DocLinkRef>();
  for (const match of text.matchAll(DOC_LINK)) {
    const id = docIdOf(match[1]);
    if (id === undefined || found.has(id)) continue;
    const version = docIdOf(match[2]);
    found.set(id, version === undefined ? { id } : { id, version });
  }
  return [...found.values()];
}

export function DocLinkCards({ text }: { text: string }) {
  const links = docLinksIn(text).slice(0, MAX_CARDS);
  if (!links.length) return null;
  return (
    <ul className="doc-cards" aria-label={links.length === 1 ? 'linked doc' : 'linked docs'}>
      {links.map((link) => (
        <li key={link.id}>
          <DocLinkCard {...link} />
        </li>
      ))}
    </ul>
  );
}

// the card always opens the local hash of the doc, never the origin of the text, so a link that names another host
// cannot make the card leave the app.
function DocLinkCard({ id, version }: DocLinkRef) {
  const { data, error } = useApi<DocDetail>(docApi(id, version));
  const href = docHref(id, version);
  if (error) {
    if (isNotFound(error)) {
      const missing = version !== undefined && /version/i.test(error) ? `Doc #${id} has no version ${version}.` : `Doc #${id} does not exist.`;
      return (
        <div className="doc-card is-missing">
          <Icon name="docs" size={16} className="doc-card-icon" />
          <span className="doc-card-note">{missing}</span>
        </div>
      );
    }
    // the doc did not load, so the card has no title. a plain link of the same size still opens it.
    return (
      <a className="doc-card is-plain" href={href}>
        <Icon name="docs" size={16} className="doc-card-icon" />
        <span className="doc-card-note">Open doc #{id}</span>
      </a>
    );
  }
  if (!data) {
    return (
      <div className="doc-card is-loading" aria-busy="true">
        <span className="sr-only">Loading doc #{id}…</span>
        <span className="doc-card-skeleton" />
      </div>
    );
  }
  const { doc } = data;
  const shown = data.version.version;
  return (
    <a className="doc-card" href={href}>
      <Icon name="docs" size={16} className="doc-card-icon" />
      <span className="doc-card-title">{doc.title}</span>
      {doc.tainted ? (
        <span className="doc-card-taint" title="Written after reading outside content" aria-label="written after reading outside content">
          !
        </span>
      ) : null}
      <span className="doc-card-info">
        <span className="badge tone-muted doc-card-kind">{kindLabel(doc.kind)}</span>
        <span className="doc-card-meta">
          {`version ${shown}${shown === doc.version ? '' : ` of ${doc.version}`} · ${time(shown === doc.version ? doc.updatedAt : data.version.createdAt)}`}
        </span>
      </span>
    </a>
  );
}
