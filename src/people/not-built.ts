// the stubs of the people track throw this until their work package fills them in. a test that reaches a stub fails
// with the name of the function, so the missing part is plain.
export class NotBuilt extends Error {
  constructor(what: string) {
    super(`${what} is not built`);
    this.name = 'NotBuilt';
  }
}

export function notBuilt(what: string): never {
  throw new NotBuilt(what);
}
