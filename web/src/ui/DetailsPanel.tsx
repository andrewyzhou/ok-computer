import { useEffect, useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useShell } from '../shell/context';
import { IconButton } from './Button';

export interface DetailsPanelProps {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  // when openKey changes to a value that is not null, the drawer of a narrow screen opens. give it the key of the
  // selected row, so a tap on a row shows its details.
  openKey?: string | number | null;
  // with onClose the panel has a close button on each screen, for example to clear the selection. without it the
  // button shows only in the drawer of a narrow screen.
  onClose?: () => void;
}

// the right column of the shell. on a screen narrower than 1100px it is a drawer that the header button opens. a
// view has one details panel at a time. outside the shell the panel renders in place.
export function DetailsPanel({ title, actions, children, openKey, onClose }: DetailsPanelProps) {
  const shell = useShell();
  useLayoutEffect(() => shell?.registerDetails(), [shell]);
  useEffect(() => {
    if (openKey !== undefined && openKey !== null) shell?.openDetails();
  }, [shell, openKey]);
  const close = () => {
    shell?.closeDetails();
    onClose?.();
  };
  const body = (
    <div className="details-inner">
      <header className="details-head">
        <h2 className="details-title">{title}</h2>
        {actions ? <div className="details-actions">{actions}</div> : null}
        <IconButton icon="close" label="Close details" size="sm" className={onClose ? undefined : 'only-drawer'} onClick={close} />
      </header>
      <div className="details-body">{children}</div>
    </div>
  );
  if (!shell) return <aside className="details-inline" aria-label="details">{body}</aside>;
  return shell.details ? createPortal(body, shell.details) : null;
}
