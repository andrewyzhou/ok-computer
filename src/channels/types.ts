export interface InboundMessage {
  channel: string;
  senderId: string;
  chatId: string;
  text: string;
  replyToMessageId?: string;
  receivedAt: string;
}

export interface Button {
  text: string;
  data: string;
}

export interface OutboundMessage {
  chatId: string;
  text: string;
  buttons?: Button[][];
}

export interface ChannelAdapter {
  id: string;
  start(onMessage: (message: InboundMessage) => void): Promise<void>;
  stop(): Promise<void>;
  send(out: OutboundMessage): Promise<{ messageId: string }>;
}
