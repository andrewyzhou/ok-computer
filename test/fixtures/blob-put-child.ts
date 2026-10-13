// a child process for the blob store race test. it puts the same texts as its siblings into one store and prints
// the number of puts that threw.
import { openDb } from '../../src/db/index.js';
import { createBlobStore } from '../../src/observability/blobs.js';

const [dbPath, dir, count] = process.argv.slice(2) as [string, string, string];
const db = openDb(dbPath);
const blobs = createBlobStore(db, dir, () => new Date());
const errors: string[] = [];
for (let i = 0; i < Number(count); i++) {
  try {
    blobs.put(`text number ${i} ${'x'.repeat(i * 50)}`);
  } catch (err) {
    errors.push((err as Error).message);
  }
}
db.close();
console.log(JSON.stringify({ errors }));
