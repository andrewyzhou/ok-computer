// the parts of the hub that are not built yet throw this error, so a call to one of them fails loudly and never looks
// like an answer.
export class NotBuiltError extends Error {
  override name = 'NotBuiltError';
}

export function notBuilt(what: string): never {
  throw new NotBuiltError(`${what} is not built`);
}
