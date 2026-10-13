export interface InboundMessage {
  channel: string;
  senderId: string;
  chatId: string;
  text: string;
  replyToMessageId?: string;
  // the data of the button that the owner pressed. a message with a button never goes to the model.
  button?: string;
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
