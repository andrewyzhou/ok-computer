import type { ChatsPage } from '../../../../src/dashboard/types';
import { useApi } from '../../api';
import { useChatStream } from '../../chat-stream';
import { EmptyState, Page, Skeleton } from '../../ui';
import { ChatView } from './ChatView';

// the Chats item of the nav opens the newest main chat, so the owner can write at once. a reset starts a new segment,
// and the page then shows that one.
export function ChatsHome() {
  const loaded = useApi<ChatsPage>('/api/chats?kind=main&limit=1', (message) => message.kind === 'event' && message.event.type === 'session_reset');
  // the first owner message makes the first chat, so an empty list loads again when one comes.
  useChatStream((event) => {
    if (event.kind === 'owner' && loaded.data && !loaded.data.chats.length) loaded.reload();
  });
  const chat = loaded.data?.chats[0];
  if (chat) return <ChatView key={chat.key} chatKey={chat.key} crumbs={[]} />;
  return (
    <Page title="Chats">
      {loaded.error ? (
        <p className="error-box">Could not load: {loaded.error}</p>
      ) : !loaded.data ? (
        <Skeleton lines={6} />
      ) : (
        <EmptyState icon="chat" title="No chat yet.">
          A message to ok computer on any channel starts the first chat.
        </EmptyState>
      )}
    </Page>
  );
}
