// the test of one url for a part that can carry data. it imports nothing, so the policy, the reply guard and the doc
// reader of the web app share one test.

// a url can carry data in its query, its fragment, a long path, or a long label of its host (dns lookups leave the pc
// too). a short url such as https://example.com/about carries no more than its choice of page. any query counts,
// because a length limit let a short secret through (24 bytes in base64 fit in 31 characters), and a false match
// costs only one call of the reviewer. the path limit is near that size for the same reason: a limit of 100 let about
// 57 bytes through. a long link usually comes from a page or a mail, and such a link passes as read. the limits on the
// path and the labels are a filter, not a proof.
export const PATH_LIMIT = 48;
export const LABEL_LIMIT = 32;

// the reason that a url can carry data, or undefined. whole is false for a candidate that has more text than the link,
// and such a candidate is judged only by the parts that carry data in place of a page name: the query, the fragment,
// and the user name and password (a browser sends them after a 401 answer).
export function linkSignal(url: URL, whole = true): string | undefined {
  if (url.search.length > 1 || url.hash.length > 1) return 'it has a query or a fragment';
  if (url.username || url.password) return 'it has a user name or a password';
  if (!whole) return undefined;
  if (url.hostname.length + url.pathname.length > PATH_LIMIT) return `its host and path have over ${PATH_LIMIT} characters`;
  if (url.hostname.split('.').some((label) => label.length > LABEL_LIMIT)) return `a label of its host has over ${LABEL_LIMIT} characters`;
  return undefined;
}
