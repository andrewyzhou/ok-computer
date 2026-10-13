import { headOf } from '../text.js';

// outside text must not close the wrapper early, or the tag of the message that holds it. the text after an early
// closing tag would then look like trusted text, or like a separate system message.
// the match stops at the next angle bracket, so a tag without its ">" does not take the text after it. the brackets
// of a tag become square brackets. this keeps the length of the text, so the wrapped text never grows past the
// limit of the preview.
// the summary request puts the transcript in a conversation tag and the old summary in a previous_summary tag, and
// the summary goes back to the model in a summary tag, so these tags are closed too.
const CLOSING_TAG = /<\s*\/\s*(untrusted|system_event|note|conversation|previous_summary|summary)\b[^<>]*>?/gi;
const neutral = (tag: string) => `[${tag.slice(1).replace(/>$/, ']')}`;

// the source names the origin, and the taint keeps it in full. in the wrapper it has a limit, so a long url cannot
// push a preview over the handle limit.
const SOURCE_LIMIT = 120;

export function wrapUntrusted(source: string, text: string): string {
  const body = text.replace(CLOSING_TAG, neutral);
  let attribute = source.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // the cut must not leave a part of an entity.
  if (attribute.length > SOURCE_LIMIT) attribute = `${headOf(attribute, SOURCE_LIMIT).replace(/&[a-z]*$/, '')}...`;
  return `<untrusted source="${attribute}">\n${body}\n</untrusted>`;
}

// a relay copies text from a tainted run into another session, for example the message of an automation to the
// owner. the copy is untrusted text, so it gets the wrapper with the sources of the taint.
export function wrapIfTainted(taint: ReadonlyArray<{ source: string }>, text: string): string {
  return taint.length ? wrapUntrusted([...new Set(taint.map((each) => each.source))].join(', '), text) : text;
}
