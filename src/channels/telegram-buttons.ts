import { createHmac, timingSafeEqual } from 'node:crypto';

// telegram allows 64 bytes of button data. the mark and its dot use 17 of them.
export const MAX_BUTTON_DATA = 47;
const MARK_LENGTH = 16;

// rich markdown can contain a button that the model wrote, with the data of a real approval. each button that the bot
// sends carries a mark from a key that the model never sees, so a press of a forged button does nothing. the key
// comes from the bot token, so it needs no storage, and a new token makes the old buttons invalid.
export function buttonSigner(botToken: string) {
  const key = createHmac('sha256', botToken).update('okc telegram button').digest();
  const mark = (data: string) => createHmac('sha256', key).update(data).digest('base64url').slice(0, MARK_LENGTH);

  return {
    sign(data: string): string {
      // longer data would go over the limit of telegram. this is a bug in the code that made the button.
      if (Buffer.byteLength(data) > MAX_BUTTON_DATA) throw new Error(`button data is longer than ${MAX_BUTTON_DATA} bytes: ${data}`);
      return `${data}.${mark(data)}`;
    },
    // check gives the data without the mark, or undefined when the mark is missing or wrong.
    check(signed: string): string | undefined {
      const at = signed.lastIndexOf('.');
      if (at < 0) return undefined;
      const data = signed.slice(0, at);
      const given = Buffer.from(signed.slice(at + 1));
      const expected = Buffer.from(mark(data));
      return given.length === expected.length && timingSafeEqual(given, expected) ? data : undefined;
    },
  };
}
