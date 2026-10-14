// the estimate uses 3 characters for each token. real sessions measured against the provider's counts showed that 4
// characters was 26 to 50% low, so a session went over the window before compaction started. all context decisions
// use this one function, so a better counter can replace it in one place.
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 3);
}
