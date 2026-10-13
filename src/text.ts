// a cut between the two halves of a surrogate pair leaves a broken character. the event log keeps such text for
// good, and a provider can refuse every later request that holds it. so each cut of text for the model or the owner
// goes through these functions.
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;

// safeEnd moves the end of a cut back before a high half, so the cut does not keep the first half of a pair.
export const safeEnd = (text: string, end: number) => (end > 0 && isHigh(text.charCodeAt(end - 1)) ? end - 1 : end);

// safeStart moves the start of a cut forward past a low half, so the cut does not start with the second half.
export const safeStart = (text: string, start: number) => (start > 0 && isHigh(text.charCodeAt(start - 1)) ? start + 1 : start);

// headOf and tailOf give at most n characters from the start or the end of the text.
export const headOf = (text: string, n: number) => text.slice(0, safeEnd(text, n));
export const tailOf = (text: string, n: number) => text.slice(safeStart(text, Math.max(0, text.length - n)));
