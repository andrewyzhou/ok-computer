import type { InboundMessage, OutboundMessage, ReplyProgress } from '../channels/types.js';

// a turn is one owner message that goes to the model, and the run that answers it. the router tells these hooks about
// each turn of every channel, so a viewer of another channel (the web chat) can follow a run that telegram started.
// the id of a turn is the messageId of its message. a hook never throws into the router, and it never waits.
export type TurnEnd = 'done' | 'failed' | 'stopped';

export interface TurnHooks {
  // an owner message passed the owner check, and it is not a button press. this also comes for a command such as
  // /status, which gets a reply and no turn.
  owner(message: InboundMessage): void;
  // the message went into the queue of the main session. busy is true when the queue held another task before it,
  // so the message waits.
  queued(message: InboundMessage, busy: boolean): void;
  // the run of the message starts with this run id. the hooks give a progress that mirrors the run for other viewers,
  // or undefined when the channel of the message shows its own progress to them. the router calls it next to the
  // progress of the channel (see teeProgress).
  started(message: InboundMessage, runId: string, stop: () => void, guard: (text: string) => string): ReplyProgress | undefined;
  // a reply to the message went out on its channel. out.replyTo is the messageId of the message.
  replied(message: InboundMessage, out: OutboundMessage): void;
  // the turn ended. done is a completed run, also one whose reply was NO_REPLY or did not go out.
  ended(message: InboundMessage, end: TurnEnd): void;
}

// tee gives one progress that calls each given progress in turn. a progress that throws does not stop the others.
export function teeProgress(...parts: Array<ReplyProgress | undefined>): ReplyProgress | undefined {
  const each = parts.filter((part): part is ReplyProgress => part !== undefined);
  if (each.length <= 1) return each[0];
  const all = (call: (part: ReplyProgress) => void) => {
    for (const part of each) {
      try {
        call(part);
      } catch {
        // a progress is a convenience, so its failure never stops the run or the other progress.
      }
    }
  };
  return {
    text: (full) => all((part) => part.text(full)),
    activity: (tools) => all((part) => part.activity(tools)),
    end: async () => void (await Promise.allSettled(each.map(async (part) => part.end()))),
    done: (ok) => all((part) => part.done(ok)),
  };
}
