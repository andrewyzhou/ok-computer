// outside text must not close the wrapper early. the text after an early closing tag would then look like trusted text.
export function wrapUntrusted(source: string, text: string): string {
  const body = text.replace(/<\s*\/\s*untrusted\b[^>]*>?/gi, '[removed closing tag]');
  const attribute = source.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<untrusted source="${attribute}">\n${body}\n</untrusted>`;
}
