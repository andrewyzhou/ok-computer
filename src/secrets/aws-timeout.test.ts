import { describe, expect, it } from 'vitest';
import { createAwsSecretStore, type SecretsManagerPort } from './aws.js';

const awsError = (name: string, message = name) => Object.assign(new Error(message), { name, $metadata: {} });

describe('the aws store and a hung request', () => {
  // the sdk client has no request timeout by default, so a host that cannot reach aws holds each get, the token
  // import and GET /api/secrets until the os gives up on the connection.
  it('gives each command an abort signal, so a request that hangs ends', async () => {
    const options: unknown[] = [];
    const send = async (_command: object, opts?: { abortSignal?: AbortSignal }) => {
      options.push(opts);
      throw awsError('ResourceNotFoundException');
    };
    const store = createAwsSecretStore({ region: 'us-east-1', client: { send } as unknown as SecretsManagerPort });
    await store.check();
    expect(options[0]).toEqual(expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
  });
});
