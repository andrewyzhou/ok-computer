import { loadConfig, loadDotEnv, loadSecrets } from './config/load.js';
import { SLOTS, type Config, type SlotConfig } from './config/schema.js';
import { openDb } from './db/index.js';
import { createClients } from './models/clients.js';
import { createSlotRunner, splitModelRef } from './models/slots.js';
import { createLogger } from './observability/logger.js';
import { registerSecret } from './observability/redact.js';

// the smoke test makes one real call for each configured provider. it uses the cheapest model of that provider in
// the slot chains. it is not part of npm test, because it costs money.
async function smoke(): Promise<void> {
  loadDotEnv();
  const loaded = loadConfig();
  if (!loaded.ok) throw new Error(loaded.error);
  const config = loaded.value;
  const secrets = loadSecrets();
  Object.values(secrets).forEach((value) => registerSecret(value));

  const logger = createLogger({ consoleLevel: 'warn' });
  const db = openDb(':memory:');
  let total = 0;
  for (const ref of cheapestModels(config)) {
    const provider = splitModelRef(ref).provider;
    const slots = everySlot({ chain: [ref], effort: 'low', maxTokens: 1024, cacheTtl: '5m' });
    const clients = createClients({ slots }, secrets);
    if (!clients.ok) {
      console.log(`${provider}: skipped (${clients.error})`);
      continue;
    }
    const runner = createSlotRunner({ db, config: { slots, pricing: config.pricing }, clients: clients.value, logger });
    const result = await runner.call(
      'utility',
      { system: '', tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the word ok.' }] }] },
      { runId: null },
    );
    const row = db.prepare('SELECT * FROM model_calls ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
    const cost = typeof row.costUsd === 'number' ? row.costUsd : null;
    total += cost ?? 0;
    console.log(
      result.ok
        ? `${ref}: "${result.response.text.trim()}" stop=${row.stopReason} in=${row.inputTokens} out=${row.outputTokens} ` +
            `cache_read=${row.cacheReadTokens} latency=${row.latencyMs}ms cost=${cost === null ? 'unknown' : `$${cost.toFixed(6)}`}`
        : `${ref}: failed: ${result.error}`,
    );
  }
  console.log(`total cost: $${total.toFixed(6)}`);
}

// every slot points at the smoke model, so createClients checks only the provider under test.
function everySlot(slot: SlotConfig): Config['slots'] {
  return Object.fromEntries(SLOTS.map((name) => [name, slot])) as Config['slots'];
}

function cheapestModels(config: Config): string[] {
  const byProvider = new Map<string, string>();
  const price = (ref: string) => config.pricing[ref]?.output ?? Infinity;
  for (const ref of Object.values(config.slots).flatMap((slot) => slot.chain)) {
    const { provider } = splitModelRef(ref);
    const current = byProvider.get(provider);
    if (!current || price(ref) < price(current)) byProvider.set(provider, ref);
  }
  return [...byProvider.values()];
}

smoke().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
