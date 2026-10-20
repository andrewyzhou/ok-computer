// the card of a doc link in the chat. an agent reply that links to a doc (a #/docs/<id> link, alone or after the
// dashboard url) gets one card for each doc under its text, with the title, the kind and the version, so the owner
// opens the doc and the chat stays short. ChatView renders it under each agent message and each live reply. the
// tools package builds it; until then it shows nothing.
export function DocLinkCards({ text }: { text: string }) {
  void text;
  return null;
}
