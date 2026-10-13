// outside text must not close the wrapper early, or the tag of the message that holds it. the text after an early
// closing tag would then look like trusted text, or like a separate system message.
const CLOSING_TAG = /<\s*\/\s*(untrusted|system_event|note)\b[^>]*>?/gi;

export function wrapUntrusted(source: string, text: string): string {
  const body = text.replace(CLOSING_TAG, '[removed closing tag]');
  const attribute = source.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<untrusted source="${attribute}">\n${body}\n</untrusted>`;
}

// a relay copies text from a tainted run into another session, for example the message of an automation to the
// owner. the copy is untrusted text, so it gets the wrapper with the sources of the taint.
export function wrapIfTainted(taint: ReadonlyArray<{ source: string }>, text: string): string {
  return taint.length ? wrapUntrusted([...new Set(taint.map((each) => each.source))].join(', '), text) : text;
}
