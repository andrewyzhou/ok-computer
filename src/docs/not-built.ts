// the scaffold of phase 6 t4 gives each function that a work package fills in this error, so a call before the
// package lands fails loudly and never returns a wrong value.
export class NotBuilt extends Error {
  constructor(what: string) {
    super(`not built: ${what}`);
    this.name = 'NotBuilt';
  }
}
