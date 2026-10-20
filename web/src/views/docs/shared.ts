import type { DocKind, DocsQuery } from '../../../../src/dashboard/docs-types';
import { apiUrl } from '../../api';

// the helpers that every docs part shares: the words for each kind, the hashes of the pages and the api paths. the
// scaffold owns this file, so a part that needs another helper keeps it in its own file.

export const KIND_LABELS: Record<DocKind, string> = {
  brief: 'Brief',
  plan: 'Plan',
  notes: 'Notes',
  comparison: 'Comparison',
  meeting_prep: 'Meeting prep',
  other: 'Other',
};

export const kindLabel = (kind: DocKind) => KIND_LABELS[kind] ?? kind;

// the hash of a doc page, with the version when it is not the newest.
export const docHref = (id: number, version?: number) => `#/docs/${id}${version === undefined ? '' : `?version=${version}`}`;

// the hash of the list, with its filters.
export function docsHref(query: Pick<DocsQuery, 'q' | 'kind'> = {}): string {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.kind) params.set('kind', query.kind);
  const text = params.toString();
  return text ? `#/docs?${text}` : '#/docs';
}

export function docsApi(query: DocsQuery = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value));
  const text = params.toString();
  return text ? `/api/docs?${text}` : '/api/docs';
}

export const docApi = (id: number, version?: number) => `/api/docs/${id}${version === undefined ? '' : `?version=${version}`}`;
export const docDiffApi = (id: number, from: number, to: number) => `/api/docs/${id}/diff?from=${from}&to=${to}`;
export const docCommentsApi = (id: number) => `/api/docs/${id}/comments`;

// the download link of the export. a plain link cannot send a header, so apiUrl adds the token when the page has one.
export const docExportHref = (id: number, version?: number) => apiUrl(`/api/docs/${id}/export${version === undefined ? '' : `?version=${version}`}`);

// a doc id from the hash. a value that is not a positive whole number gives undefined, and the page shows its not
// found state.
export function docIdOf(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9]\d{0,15}$/.test(value)) return undefined;
  return Number(value);
}
