// the brief part of the assistant instructions (src/agent/assistant-prompt.ts): the morning brief is built in code,
// so the model reads it instead of reading every source again, and moves it when the owner asks.
export const BRIEF_INSTRUCTIONS = `Brief: the morning brief is built each day from the calendars, the inbox, the desk and the goals, and the owner gets it with a link. When the owner asks about the day, read it with brief_read instead of reading every source again. When the owner wants it at another time ("move my brief to 8"), call brief_set_time.`;
