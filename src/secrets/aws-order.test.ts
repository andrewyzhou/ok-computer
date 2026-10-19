import { describe, expect, it } from 'vitest';
import { createAwsSecretStore, type SecretsManagerPort } from './aws.js';

const awsError = (name: string, message = name) => Object.assign(new Error(message), { name, $metadata: {} });

describe('the aws store and two sets of one ref', () => {
  // two sets of one ref in one process must end with the value of the set that was called last, as the file store does.
  it('keeps the value of the last set when two sets of a new ref race', async () => {
    const secrets = new Map<string, string>();
    let releaseFirstCreate!: () => void;
    const firstCreate = new Promise<void>((resolve) => (releaseFirstCreate = resolve));
    let creates = 0;
    const send = async (command: { input: Record<string, unknown> }) => {
      const id = String(command.input.SecretId ?? command.input.Name);
      switch (command.constructor.name) {
        case 'PutSecretValueCommand':
          if (!secrets.has(id)) throw awsError('ResourceNotFoundException');
          secrets.set(id, String(command.input.SecretString));
          return {};
        case 'CreateSecretCommand': {
          // the network delays the create of the first set.
          if (creates++ === 0) await firstCreate;
          if (secrets.has(id)) throw awsError('ResourceExistsException');
          secrets.set(id, String(command.input.SecretString));
          return {};
        }
        default:
          throw awsError('ResourceNotFoundException');
      }
    };
    const store = createAwsSecretStore({ region: 'us-east-1', client: { send } as unknown as SecretsManagerPort });
    const first = store.set('google.personal', 'first-token-value-1111');
    const second = store.set('google.personal', 'second-token-value-2222');
    // with a queue for each ref, the second set waits for the first, which waits for the gate.
    releaseFirstCreate();
    await Promise.all([first, second]);
    expect(secrets.get('okc/google.personal')).toBe('second-token-value-2222');
  });
});
