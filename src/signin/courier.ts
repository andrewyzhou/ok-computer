import type { ChannelAdapter } from '../channels/types.js';
import type { SignInHost } from '../dashboard/signin-types.js';
import type { Logger } from '../observability/logger.js';
import type { CodeCourier } from './types.js';

const TELEGRAM = 'telegram';

// the code goes straight to the owner's private telegram chat, never through the owner messenger: that one can choose
// the cli and copies each message to the web chat. a code is a secret, so it is never logged and never in the trace.
export function createTelegramCourier(deps: { channels: Map<string, ChannelAdapter>; ownerIds: Record<string, string>; logger: Logger }): CodeCourier {
  const { channels, ownerIds } = deps;
  return {
    available: () => channels.has(TELEGRAM) && Boolean(ownerIds[TELEGRAM]),
    send(text) {
      void text;
      throw new Error('not built: the telegram courier');
    },
  };
}

// codeMessage gives the text of the message with the code. it names the host that asked for it, so the owner can tell
// a code that someone else asked for.
export function codeMessage(code: string, host: SignInHost, minutes: number): string {
  void code;
  void host;
  void minutes;
  throw new Error('not built: codeMessage');
}
