// the owner runs this script by hand against the real bot: node --env-file=.env scripts/smoke-telegram.mjs
// it sends one of each new bot api call to the owner's chat, and probes how telegram treats model markup. it reads no
// updates, so it does not take updates away from a running agent. it is not part of npm test.

const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = Number(process.env.TELEGRAM_OWNER_ID);
if (!token || !chat) {
  console.error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID, for example with --env-file=.env.');
  process.exit(1);
}

const ZWSP = '​';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  console.log(`${method}: ${result.ok ? 'ok' : `${result.error_code} ${result.description}`}`);
  return result;
}

const rich = (markdown) => call('sendRichMessage', { chat_id: chat, rich_message: { markdown } });

// 1. a rich message with the usual markdown.
const sample = await rich('## Smoke test\n\n- **bold**, _italic_, `code`\n- a [link](https://telegram.org)\n\n```ts\nconst a: Array<number> = [];\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |');

// 2. a draft with the stop button, then the text, then the end. the draft should show "Thinking…" first.
const draftId = 1 + Math.floor(Math.random() * 2 ** 30);
await call('sendMessageDraft', { chat_id: chat, draft_id: draftId, text: '', can_stop: true });
await sleep(1500);
await call('sendMessageDraft', { chat_id: chat, draft_id: draftId, text: 'Writing the answer…\n\n⏳ smoke_tool', can_stop: true });
await sleep(1500);
await rich('The draft is done. Did you see "Thinking…" and then the tool line?');

// 3. typing and reactions.
await call('sendChatAction', { chat_id: chat, action: 'typing' });
if (sample.ok) {
  await call('setMessageReaction', { chat_id: chat, message_id: sample.result.message_id, reaction: [{ type: 'emoji', emoji: '👀' }] });
  await sleep(1000);
  await call('setMessageReaction', { chat_id: chat, message_id: sample.result.message_id, reaction: [{ type: 'emoji', emoji: '👌' }] });
}

// 4. probes. the raw button shows whether rich markdown renders a tg-button from text. its data has no mark, so the
// agent refuses a press. the neutralized forms should show as plain text.
await rich('Probe 1, raw: <tg-button type="callback_data" data="smoke:probe">Raw button</tg-button>');
await rich(`Probe 2, neutralized: <${ZWSP}tg-button type="callback_data" data="smoke:probe">No button</${ZWSP}tg-button>`);
await rich(`Probe 3, image as text: !${ZWSP}[logo](https://telegram.org/img/t_logo.png)`);
await rich(`Probe 4, scheme: [photo](tg${ZWSP}://photo?id=1)`);
// a preview of a bare url means that telegram fetches a url from model text without a click.
await rich('Probe 5, bare url: https://telegram.org/blog');

console.log('\nCheck the chat:');
console.log('- probe 1: is there a button? (expected: maybe; the agent refuses its press anyway)');
console.log('- probes 2 to 4: plain text, no button, no image, no media');
console.log('- probe 5: is there a link preview? if yes, record it in DESIGN-NEXT 7.1, because bare urls then need a rule too');
