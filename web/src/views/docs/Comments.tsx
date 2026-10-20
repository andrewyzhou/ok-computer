import type { DocComment, DocSummary } from '../../../../src/dashboard/docs-types';

export interface DocCommentsProps {
  doc: DocSummary;
  // the version on the page. a new comment is about this version.
  version: number;
  comments: DocComment[];
  // the text that the owner selected in the doc, offered as the quote of a new comment. empty when none is selected.
  selection?: string;
  // the page loads the doc again after a comment is added, so the list and the count come from the server.
  onAdded: () => void;
}

// the owner's comments on a doc and the form for a new one. the doc page renders it in its details panel, and below
// the doc at 390. the comments package builds it.
export function DocComments(props: DocCommentsProps) {
  void props;
  return null;
}
