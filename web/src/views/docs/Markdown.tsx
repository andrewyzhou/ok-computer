// the safe markdown of a doc. the model writes the text, so the renderer makes react elements from the tokens of
// marked and never sets html: raw html shows as text, an image loads only after a click, and only an http(s), mailto
// or #/ link is clickable. the reader package builds it; until then the text shows as plain text.
export function Markdown({ text }: { text: string }) {
  return <div className="doc-markdown doc-plain">{text}</div>;
}
