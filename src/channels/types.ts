export interface InboundMessage {
  channel: string;
  senderId: string;
  chatId: string;
  text: string;
  // the id of the message in its chat. a channel uses it to react to the message.
  messageId?: string;
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
  // the text is the model's markdown. other text, for example an approval card, is sent as plain text.
  markdown?: boolean;
  // details go in a block that the owner can open, for example the exact input of an approval.
  details?: string;
  // the run that wrote the text. the log of the channel names it.
  runId?: string;
}

// progress shows the owner that a run works on a message, and lets the owner stop it.
export interface ReplyProgress {
  // text gives the full text of the current model call so far.
  text(full: string): void;
  // activity gives the names of the tools that run now, or undefined when none runs.
  activity(tools: string | undefined): void;
  // end stops the progress. the router calls it before the reply goes out.
  end(ok: boolean): Promise<void>;
}

export interface ChannelAdapter {
  id: string;
  start(onMessage: (message: InboundMessage) => void): Promise<void>;
  stop(): Promise<void>;
  send(out: OutboundMessage): Promise<{ messageId: string }>;
  // the channel calls stop when the owner presses the stop button of the reply.
  progress?(message: InboundMessage, stop: () => void): ReplyProgress;
}
