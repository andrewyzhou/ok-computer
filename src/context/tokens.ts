// the estimate uses 4 characters for each token. all context decisions use this one function, so a better
// counter can replace it in one place.
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}
