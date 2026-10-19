import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ApprovalRow, ChatButton, ChatMessage, ChatRow, ContextView } from '../../../../src/dashboard/types';
import { send, useApi, useStream } from '../../api';
import { applyTurnAction, currentTurns, isActive, useChatConnection, useChatStream, useLiveTurns, type LiveReply, type LiveTurn, type StandaloneReply } from '../../chat-stream';
import { Expand } from '../../components';
import { clock, time, tokens, usd } from '../../format';
import type { Crumb } from '../../shell/context';
import { useDevMode } from '../../shell/prefs';
import { ApprovalCard, Badge, Button, ButtonLink, DetailsPanel, EmptyState, Facts, Page, Skeleton, Status } from '../../ui';
import { Composer } from './Composer';
import { chatHref, scrollParent, useTranscript } from './data';

// the ended turns of the list that the transcript shows now. a turn with a reply waits until the transcript holds a
// message of its run, so a reply never leaves the page before the stored copy is there.
function shownTurns(turnIds: string[], messages: ChatMessage[]): string[] {
  const runs = new Set(messages.map((message) => message.runId).filter((runId) => runId !== null));
  const turns = currentTurns();
  return turnIds.filter((id) => {
    const turn = turns.get(id);
    if (!turn || isActive(turn)) return false;
    if (!turn.reply) return true;
    if (turn.runId !== null) return runs.has(turn.runId);
    const text = turn.reply.text;
    return messages.some((message) => message.role === 'agent' && message.text === text);
  });
}

function endedTurns(): string[] {
  return [...currentTurns().values()].filter((turn) => !isActive(turn)).map((turn) => turn.turnId);
}
import { ToolChips } from './ToolChips';
import './chats.css';

// one chat: the transcript of the delivered text, the live turns of the open main segment and the composer. the
// activity views use the same component with mode activity, which is read-only.

export interface ChatViewProps {
  chatKey: string;
  mode?: 'chat' | 'activity';
  crumbs?: Crumb[];
}

function RunLinks({ runId }: { runId: string }) {
  const devMode = useDevMode();
  return (
    <span className="chat-links">
      <a href={`#/runs/${encodeURIComponent(runId)}`} aria-label={`run ${runId}`}>
        run
      </a>
      {devMode ? (
        <a href={`#/trace/${encodeURIComponent(runId)}`} aria-label={`trace of run ${runId}`}>
          trace
        </a>
      ) : null}
    </span>
  );
}

// the buttons of a reply. their data goes to the app as a pressed button, and never to the model.
function ReplyButtons({ buttons, turnId }: { buttons: ChatButton[][]; turnId?: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ text: string; error: boolean } | null>(null);
  if (!buttons.length) return null;
  const press = (button: ChatButton) => {
    setBusy(button.data);
    setAnswer(null);
    send('/api/chat/button', 'POST', turnId ? { data: button.data, turnId } : { data: button.data }).then(
      () => {
        setBusy(null);
        setAnswer({ text: `${button.text}: sent`, error: false });
      },
      (err: Error) => {
        setBusy(null);
        setAnswer({ text: err.message, error: true });
      },
    );
  };
  return (
    <div className="chat-buttons">
      {buttons.map((row, index) => (
        <div key={index} className="chat-button-row">
          {row.map((button) => (
            <Button key={button.data} size="sm" busy={busy === button.data} disabled={busy !== null} onClick={() => press(button)}>
              {button.text}
            </Button>
          ))}
        </div>
      ))}
      {answer ? (
        <span role="status" className={answer.error ? 'error-text' : 'muted'}>
          {answer.text}
        </span>
      ) : null}
    </div>
  );
}

function Reply({ reply, turnId }: { reply: LiveReply; turnId?: string }) {
  return (
    <>
      <p className="chat-text">{reply.text}</p>
      <ReplyButtons buttons={reply.buttons} {...(turnId ? { turnId } : {})} />
      {reply.details ? (
        <Expand label="details">{() => <p className="chat-text chat-details">{reply.details}</p>}</Expand>
      ) : null}
    </>
  );
}

function InlineApproval({ id, approvals, onDecided }: { id: number; approvals: Map<number, ApprovalRow> | undefined; onDecided: () => void }) {
  const approval = approvals?.get(id);
  if (!approvals) return <Skeleton lines={1} label="Loading the approval…" />;
  if (!approval)
    return (
      <a className="chat-approval-link" href="#/approvals">
        approval #{id}
      </a>
    );
  return <ApprovalCard approval={approval} compact onDecided={onDecided} />;
}

function Message({
  message,
  showRun,
  approvals,
  onDecided,
}: {
  message: ChatMessage;
  showRun: boolean;
  approvals: Map<number, ApprovalRow> | undefined;
  onDecided: () => void;
}) {
  const approval = message.approvalId !== null ? <InlineApproval id={message.approvalId} approvals={approvals} onDecided={onDecided} /> : null;
  if (message.role === 'system')
    return (
      <li className="chat-system" data-testid="chat-message">
        <span>
          {message.text} · {time(message.createdAt)}
        </span>
      </li>
    );
  if (message.role === 'owner')
    return (
      <li className="chat-msg chat-owner" data-testid="chat-message">
        <div className="chat-meta">
          <span>you</span>
          {message.channel ? <span>on {message.channel}</span> : null}
          <time dateTime={message.createdAt}>{clock(message.createdAt)}</time>
        </div>
        <p className="chat-text">{message.text}</p>
      </li>
    );
  if (message.role === 'note')
    return (
      <li className="chat-msg chat-note" data-testid="chat-message">
        <div className="chat-meta">
          {message.guarded ? <Badge tone="warning">guard note</Badge> : <span>note</span>}
          <time dateTime={message.createdAt}>{clock(message.createdAt)}</time>
        </div>
        <p className="chat-text">{message.text}</p>
        {approval}
      </li>
    );
  return (
    <li className="chat-msg chat-agent" data-testid="chat-message">
      <div className="chat-meta">
        <span>ok computer</span>
        <time dateTime={message.createdAt}>{clock(message.createdAt)}</time>
        {message.guarded ? <Badge tone="warning">guarded</Badge> : null}
        {message.runId && showRun ? <RunLinks runId={message.runId} /> : null}
      </div>
      <p className="chat-text">{message.text}</p>
      {approval}
      {message.runId && showRun ? <ToolChips runId={message.runId} /> : null}
    </li>
  );
}

function Turn({ turn }: { turn: LiveTurn }) {
  const active = isActive(turn);
  return (
    <li className="chat-turn" data-testid="chat-turn" aria-busy={active || undefined}>
      {turn.ownerText !== undefined ? (
        <div className="chat-msg chat-owner">
          <div className="chat-meta">
            <span>you</span>
            <span>on {turn.channel}</span>
            {active ? <Status value={turn.state} /> : null}
          </div>
          <p className="chat-text">{turn.ownerText}</p>
        </div>
      ) : null}
      <div className="chat-msg chat-agent" aria-live="polite">
        <div className="chat-meta">
          <span>ok computer</span>
          {turn.ownerText === undefined || !active ? <Status value={turn.state} /> : null}
          {turn.runId ? <RunLinks runId={turn.runId} /> : null}
        </div>
        {turn.reply ? (
          <Reply reply={turn.reply} turnId={turn.turnId} />
        ) : turn.text || active ? (
          <p className="chat-text">
            {turn.text}
            {active ? <span className="chat-caret" aria-hidden="true" /> : null}
          </p>
        ) : null}
        {turn.activity ? <p className="chat-activity muted">using {turn.activity}</p> : null}
        {turn.error ? (
          <p role="alert" className="error-text">
            {turn.error}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function Standalone({ reply }: { reply: StandaloneReply }) {
  return (
    <li className="chat-msg chat-agent" data-testid="chat-standalone">
      <div className="chat-meta">
        <span>ok computer</span>
        <time dateTime={reply.at}>{clock(reply.at)}</time>
        {reply.runId ? <RunLinks runId={reply.runId} /> : null}
      </div>
      <Reply reply={reply} />
    </li>
  );
}

function ChatDetails({ chat, open }: { chat: ChatRow; open: boolean }) {
  const devMode = useDevMode();
  const connection = useChatConnection();
  const context = useApi<ContextView>(open ? `/api/sessions/${encodeURIComponent(chat.sessionKey)}/context` : null);
  // the estimate grows with each turn, so it loads again when one ends.
  useChatStream((event) => {
    if (open && event.kind === 'done') context.reload();
  });
  return (
    <DetailsPanel title="Chat">
      <Facts
        layout="stacked"
        items={[
          { label: 'Kind', value: chat.kind },
          { label: 'Channel', value: chat.channel ?? <span className="muted">none</span> },
          { label: 'First', value: time(chat.firstAt) },
          { label: 'Last', value: time(chat.lastAt) },
          { label: 'Runs', value: chat.runs },
          { label: 'Cost', value: usd(chat.costUsd) },
          { label: 'Pending approvals', value: chat.pendingApprovals },
          open && {
            label: 'Next request',
            value: context.data ? (
              <span>{tokens(context.data.estimatedTokens)} tokens, estimated</span>
            ) : context.error ? (
              <span className="muted">unknown: {context.error}</span>
            ) : (
              <span className="muted">estimating…</span>
            ),
          },
          devMode && { label: 'Session', value: <a href={`#/sessions/${encodeURIComponent(chat.sessionKey)}`}>{chat.sessionKey}</a> },
          devMode && { label: 'Chat stream', value: <Status value={connection} /> },
        ]}
      />
    </DetailsPanel>
  );
}

// the runs of a turn give several agent messages at times. the links and the tool chips show once, on the last one.
function lastOfRun(messages: ChatMessage[]): Set<number> {
  const last = new Map<string, number>();
  for (const message of messages) if (message.role === 'agent' && message.runId) last.set(message.runId, message.id);
  return new Set(last.values());
}

export function ChatView({ chatKey, mode = 'chat', crumbs }: ChatViewProps) {
  const transcript = useTranscript(chatKey);
  const { chat, messages } = transcript;
  const live = useLiveTurns();
  const list = useRef<HTMLOListElement>(null);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const started = useRef(false);
  const open = mode === 'chat' && chat?.kind === 'main' && chat.toEventId === null;
  // the activity area is for the background sessions. a link there to the owner's chat opens it in the chats area,
  // where it has its composer and the right words. the hash is replaced, so the back button skips the activity link.
  const mainInActivity = mode === 'activity' && chat?.kind === 'main';
  useEffect(() => {
    if (!mainInActivity) return;
    history.replaceState(history.state, '', chatHref(chatKey, 'chats'));
    dispatchEvent(new Event('hashchange'));
  }, [mainInActivity, chatKey]);

  const needsApprovals = messages.some((message) => message.approvalId !== null);
  const approvalsLoaded = useApi<ApprovalRow[]>(needsApprovals ? '/api/approvals' : null, (message) => message.kind === 'approval');
  const approvals = useMemo(() => (approvalsLoaded.data ? new Map(approvalsLoaded.data.map((row) => [row.id, row])) : undefined), [approvalsLoaded.data]);

  // a turn that ended shows from the transcript, so the live copy goes after the reload. a failed reload keeps the live
  // copy, and the error shows above the composer. the next end of a turn, or the next snapshot, tries again.
  const settle = () => {
    const ended = endedTurns();
    void transcript.reloadNewest().then((page) => {
      if (!page) return;
      const shown = shownTurns(ended, page.messages);
      if (shown.length) applyTurnAction({ kind: 'drop', turnIds: shown });
    });
  };
  useChatStream((event) => {
    if (!open) return;
    // a snapshot after a reconnect leaves out the turns that ended while the stream was down, and the page never saw
    // their done events, so the transcript loads again for them.
    if (event.kind === 'done' || (event.kind === 'snapshot' && chat)) settle();
  });
  // a reset ends the open segment. the transcript loads again, so the page shows it as read-only.
  useStream((message) => {
    if (message.kind === 'event' && message.event.type === 'session_reset' && chat && message.event.sessionKey === chat.sessionKey) void transcript.reloadNewest();
  });

  // the turns that ended before this page loaded its transcript are in the transcript already.
  const loadedOnce = Boolean(chat);
  useEffect(() => {
    if (!loadedOnce) return;
    const shown = shownTurns(endedTurns(), messages);
    if (shown.length) applyTurnAction({ kind: 'drop', turnIds: shown });
    // only the first load drops, so a turn that ends later stays until its own reload.
  }, [loadedOnce]);

  const turns = open ? [...live.turns.values()] : [];
  // stop goes to the running turn. a follow-up that waits in the queue has nothing to stop yet, so it is the turn of
  // the Stop button only when no turn runs.
  const active = turns.find((turn) => turn.state === 'running') ?? turns.find(isActive);

  // the first page starts at the newest message. an older page keeps the message that was at the top in its place.
  useLayoutEffect(() => {
    const scroller = scrollParent(list.current);
    if (anchor.current) {
      scroller.scrollTop = scroller.scrollHeight - anchor.current.height + anchor.current.top;
      anchor.current = null;
    } else if (!started.current && messages.length) {
      started.current = true;
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [messages]);

  const loadOlder = () => {
    const scroller = scrollParent(list.current);
    anchor.current = { height: scroller.scrollHeight, top: scroller.scrollTop };
    void transcript.loadOlder().then((loaded) => {
      // nothing changed when the load failed, so the next render must not move the page.
      if (!loaded) anchor.current = null;
    });
  };

  if (transcript.notFound)
    return (
      <Page title="Chat not found" {...(crumbs ? { crumbs } : {})}>
        <EmptyState icon="chat" title="This chat does not exist." action={<ButtonLink href={mode === 'activity' ? '#/activity' : '#/chats'}>Back to the list</ButtonLink>}>
          {transcript.error}
        </EmptyState>
      </Page>
    );
  if (!chat)
    return (
      <Page title={mode === 'activity' ? 'Activity' : 'Chat'} {...(crumbs ? { crumbs } : {})}>
        {transcript.error ? <p className="error-box">Could not load: {transcript.error}</p> : <Skeleton lines={6} />}
      </Page>
    );

  const ids = lastOfRun(messages);
  const subtitle = (
    <span className="chat-subtitle">
      {chat.channel ?? chat.kind} · {time(chat.firstAt)} to {time(chat.lastAt)}
    </span>
  );
  return (
    <Page title={chat.title} subtitle={subtitle} {...(crumbs ? { crumbs } : {})}>
      <div className={open ? 'chat-view chat-view-open' : 'chat-view'}>
        {transcript.before !== null ? (
          <div className="chat-older">
            <Button variant="ghost" size="sm" busy={transcript.olderBusy} onClick={loadOlder}>
              Load older messages
            </Button>
            {transcript.olderError ? <span className="error-text">{transcript.olderError}</span> : null}
          </div>
        ) : messages.length ? (
          <p className="chat-start muted">This is the start of the chat.</p>
        ) : null}
        <ol className="chat-log" ref={list} aria-label="transcript">
          {messages.map((message) => (
            <Message key={message.id} message={message} showRun={ids.has(message.id)} approvals={approvals} onDecided={approvalsLoaded.reload} />
          ))}
          {open ? live.standalone.map((reply) => <Standalone key={reply.messageId} reply={reply} />) : null}
          {turns.map((turn) => (
            <Turn key={turn.turnId} turn={turn} />
          ))}
        </ol>
        {!messages.length && !turns.length ? (
          <EmptyState icon="chat" title="No messages yet.">
            {open ? 'Write below to start.' : null}
          </EmptyState>
        ) : null}
        {open ? (
          <div className="chat-dock">
            {transcript.error ? <p className="error-text">Could not load the newest messages: {transcript.error}</p> : null}
            <Composer active={active} />
          </div>
        ) : mode === 'chat' && chat.kind === 'main' ? (
          <p className="chat-readonly muted">
            This chat ended with a session reset, so it is read-only. <a href="#/chats">Open the current chat</a>
          </p>
        ) : (
          <p className="chat-readonly muted">A background session is read-only.</p>
        )}
      </div>
      <ChatDetails chat={chat} open={open} />
    </Page>
  );
}
