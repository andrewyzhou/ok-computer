import type { ChatMessage, ChatRow } from '../../../../src/dashboard/types';

// the rows of the chat tests. the endpoints of the chats are built in parallel, so the tests stub them with these.

export function chatRow(change: Partial<ChatRow> = {}): ChatRow {
  return {
    key: 'main@0',
    kind: 'main',
    sessionKey: 'main',
    fromEventId: 1,
    toEventId: null,
    title: 'my goals: essay by 21:00',
    channel: 'telegram',
    preview: 'Saved your two goals.',
    firstAt: '2026-10-13T01:00:00.000Z',
    lastAt: '2026-10-13T01:30:00.000Z',
    runs: 4,
    costUsd: 0.0123,
    lastRunStatus: 'completed',
    pendingApprovals: 0,
    ...change,
  };
}

let nextId = 100;

export function message(change: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: nextId++,
    role: 'agent',
    runId: null,
    channel: null,
    text: 'hello',
    guarded: false,
    approvalId: null,
    createdAt: '2026-10-13T01:00:00.000Z',
    ...change,
  };
}
