import { createInterface, type Interface } from 'node:readline';
import type { Clock } from '../time.js';
import type { Button, ChannelAdapter } from './types.js';

export const CLI_CHAT_ID = 'local';

export interface CliOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  clock?: Clock;
  // the cli calls this when the input ends.
  onClose?: () => void;
}

export interface CliWanted {
  chatMode: boolean;
  telegram: boolean;
  service: boolean;
  tty: boolean;
}

// okc.sh and the login agent of macos start the agent with OKC_SERVICE=1 and /dev/null as stdin. the cli would see the
// end of its input at once and stop the agent, so a service runs no cli. npm run chat is always the cli. otherwise the
// cli runs when no other channel runs, or when a terminal is attached.
export function cliWanted(each: CliWanted): boolean {
  if (each.chatMode) return true;
  if (each.service) return false;
  return !each.telegram || each.tty;
}

// the cli channel is a terminal chat for development. the person at the terminal is the owner.
export function createCliChannel(options: CliOptions = {}): ChannelAdapter {
  const output = options.output ?? process.stdout;
  const clock = options.clock ?? (() => new Date());
  let rl: Interface | undefined;
  let sent = 0;
  let choices: Button[] = [];

  return {
    id: 'cli',
    async start(onMessage) {
      rl = createInterface({ input: options.input ?? process.stdin });
      rl.on('line', (line) => {
        const text = line.trim();
        if (!text) return;
        // a number right after a message with choices presses that button.
        const choice = /^\d+$/.test(text) ? choices[Number(text) - 1] : undefined;
        choices = [];
        onMessage({
          channel: 'cli',
          senderId: 'owner',
          chatId: CLI_CHAT_ID,
          text,
          receivedAt: clock().toISOString(),
          ...(choice ? { button: choice.data } : {}),
        });
      });
      rl.on('close', () => options.onClose?.());
    },
    async stop() {
      rl?.removeAllListeners('close');
      rl?.close();
    },
    async send(out) {
      // the terminal cannot show buttons, so the cli shows them as numbered choices.
      // a later message without buttons removes the choices, so a number that answers it cannot press an old button.
      const buttons = (out.buttons ?? []).flat();
      choices = buttons;
      const lines = buttons.map((button, i) => `  ${i + 1}. ${button.text}`);
      const details = out.details === undefined ? '' : `\n${out.details}`;
      output.write(`\nokc> ${out.text}${details}\n${lines.length ? lines.join('\n') + '\n' : ''}\n`);
      return { messageId: String(++sent) };
    },
  };
}
