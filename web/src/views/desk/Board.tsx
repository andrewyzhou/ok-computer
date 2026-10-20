import type { DeskBoard } from '../../../../src/dashboard/desk-types';

// the columns of the board, one for each status, with a card for each delegation: the title, who it waits on, the
// due time and the next step. below 760px the columns stack into one list with a heading for each status. the work
// package "desk board" builds it.
export interface BoardProps {
  board: DeskBoard;
  // the id of the selected delegation, whose card is marked.
  selectedId: number | null;
  onSelect: (id: number) => void;
  // the time that the due words count from, so a test can fix it.
  now?: Date;
}

export function Board(_props: BoardProps) {
  return null;
}
