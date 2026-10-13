import { createInterface, type Interface } from 'node:readline';
import type { Clock } from '../time.js';
import type { ChannelAdapter } from './types.js';

export const CLI_CHAT_ID = 'local';

export interface CliOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  clock?: Clock;
  // the cli calls this when the input ends.
  onClose?: () => void;
}

// the cli channel is a terminal chat for development. the person at the terminal is the owner.
export function createCliChannel(options: CliOptions = {}): ChannelAdapter {
  const output = options.output ?? process.stdout;
  const clock = options.clock ?? (() => new Date());
  let rl: Interface | undefined;
  let sent = 0;

  return {
    id: 'cli',
    async start(onMessage) {
      rl = createInterface({ input: options.input ?? process.stdin });
      rl.on('line', (line) => {
        const text = line.trim();
        if (!text) return;
        onMessage({ channel: 'cli', senderId: 'owner', chatId: CLI_CHAT_ID, text, receivedAt: clock().toISOString() });
      });
      rl.on('close', () => options.onClose?.());
    },
    async stop() {
      rl?.removeAllListeners('close');
      rl?.close();
    },
    async send(out) {
      // the terminal cannot show buttons, so the cli shows them as numbered choices.
      const choices = (out.buttons ?? []).flat().map((button, i) => `  ${i + 1}. ${button.text}`);
      output.write(`\nokc> ${out.text}\n${choices.length ? choices.join('\n') + '\n' : ''}\n`);
      return { messageId: String(++sent) };
    },
  };
}
