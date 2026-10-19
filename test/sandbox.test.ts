import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db/index.js';
import { listEvents } from '../src/events/log.js';
import { createFakeClient, textStep, toolStep, type FakeStep } from '../src/models/fake.js';
import { REVIEW_TOOL } from '../src/policy/reviewer.js';
import { DEFAULT_LIMITS, SANDBOX_IMAGE } from '../src/sandbox/limits.js';
import type { Scratch } from '../src/sandbox/scratch.js';
import { STALE_ERROR, startExec } from '../src/sandbox/store.js';
import { SANDBOX_EXEC } from '../src/sandbox/tool.js';
import type { DockerClient, ExecRequest, ExecResult, NetworkGate, NetworkPlan } from '../src/sandbox/types.js';
import { createTestApp } from './app-harness.js';

const start = '2026-10-18T09:00:00-07:00';

const exec = (id: string, input: Record<string, unknown>) => toolStep({ id, name: SANDBOX_EXEC, input });
const verdict = (value: 'allow' | 'hold', reason: string) => toolStep({ id: 'v', name: REVIEW_TOOL, input: { verdict: value, reason } });

// the fake docker answers the probe and the start sweep. a test that reaches any other method fails, because the runner
// is a fake too.
const fakeDocker = (): DockerClient =>
  new Proxy({} as DockerClient, {
    get(_target, key) {
      if (key === 'info') return async () => ({ engine: 'docker 28.3.0 (linux/arm64)', os: 'linux', arch: 'arm64' });
      if (key === 'imageId') return async () => 'sha256:img';
      // the start sweep finds nothing to remove.
      if (key === 'listContainers' || key === 'listNetworks') return async () => [];
      if (key === 'then') return undefined;
      return () => {
        throw new Error(`docker.${String(key)} is not expected in this test`);
      };
    },
  });

function fakes() {
  const requests: ExecRequest[] = [];
  const runner = {
    run: async (request: ExecRequest): Promise<ExecResult> => {
      requests.push(request);
      return {
        status: 'ok',
        exitCode: 0,
        stdout: Buffer.from('42\n'),
        stderr: Buffer.alloc(0),
        stdoutBytes: 3,
        stderrBytes: 0,
        truncated: false,
        collected: [],
        notCollected: [],
        containerId: 'cafe',
        imageId: 'sha256:img',
        durationMs: 300,
        error: null,
        scratchBytes: 0,
      };
    },
  };
  const closed: number[] = [];
  const plan = (execId: number): NetworkPlan => ({
    networkMode: `okc-net-${execId}`,
    env: ['HTTPS_PROXY=http://okc-proxy:3128'],
    extraHosts: [],
    passed: () => ['pypi.org'],
    refused: () => [],
    close: async () => {
      closed.push(execId);
    },
  });
  const network: NetworkGate = { check: async () => ({ ok: true }), open: async (execId) => plan(execId) };
  const scratch: Scratch = {
    volumeFor: async () => ({ taskId: 'task-1', volume: 'okc-scratch-task-1' }),
    afterExec: async () => ({ reset: false }),
    sweep: async () => 0,
  };
  return { requests, closed, deps: { docker: fakeDocker(), runner, network, scratch } };
}

const apps: Array<{ app: { stop(): Promise<void> } }> = [];
afterEach(async () => {
  for (const each of apps.splice(0)) await each.app.stop();
});

type Extra = NonNullable<Parameters<typeof createTestApp>[1]['deps']>;
// the reviewer runs on the utility slot with its own script, as in test/review.test.ts.
async function setup(steps: FakeStep[], reviews: FakeStep[], extra: Extra = {}, withSandbox = true) {
  const sandbox = fakes();
  const main = createFakeClient(steps);
  const reviewer = createFakeClient(reviews, 'rev');
  const t = createTestApp([], {
    start,
    config: { slots: { main: { chain: ['fake/m'] }, heartbeat: { chain: ['fake/m'] }, utility: { chain: ['rev/r'] } } },
    deps: { clients: { fake: main, rev: reviewer }, ...(withSandbox ? { sandbox: sandbox.deps } : {}), ...extra },
  });
  apps.push(t);
  await t.app.start();
  return { ...t, main, reviewer, ...sandbox };
}

const resultOf = (t: { db: Parameters<typeof listEvents>[0] }, id: string) =>
  (listEvents(t.db, 'main').find((event) => event.type === 'tool_result' && event.payload.toolCallId === id)?.payload as { content: string } | undefined)?.content;

describe('code sandbox acceptance', () => {
  it('sends a sandbox call to the reviewer, runs it on allow, and links its trace to the tool call', async () => {
    const t = await setup([exec('x1', { language: 'python', code: 'print(6 * 7)' }), textStep('It is 42.')], [verdict('allow', 'the owner asked for the sum')]);
    await t.say('what is 6 times 7? use python');

    expect(t.rows("SELECT toolName, decision, rule, reviewerVerdict FROM policy_decisions WHERE toolCallId = 'x1'")).toEqual([
      { toolName: SANDBOX_EXEC, decision: 'review', rule: 'risk:exec', reviewerVerdict: 'allow' },
    ]);
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]).toMatchObject({ image: SANDBOX_IMAGE, argv: ['python3', '-c', 'print(6 * 7)'], volume: 'okc-scratch-task-1' });
    expect(t.requests[0]!.network).toBeUndefined();

    const call = t.rows("SELECT runId, toolCallId, source, riskLevel, isError FROM tool_calls WHERE toolCallId = 'x1'")[0] as { runId: string };
    expect(call).toEqual({ runId: expect.any(String), toolCallId: 'x1', source: 'sandbox', riskLevel: 'exec', isError: 0 });
    expect(t.rows('SELECT runId, toolCallId, sessionKey, language, command, network, status, exitCode, stdoutBytes FROM sandbox_execs')).toEqual([
      { runId: call.runId, toolCallId: 'x1', sessionKey: 'main', language: 'python', command: 'print(6 * 7)', network: 'none', status: 'ok', exitCode: 0, stdoutBytes: 3 },
    ]);
    expect(resultOf(t, 'x1')).toContain('Exit code 0 (ok) in 0.3 s. Sandbox exec 1.');
    expect(resultOf(t, 'x1')).toContain('42');
    expect(t.printed()).toContain('It is 42.');
  });

  it('does not run a call that the reviewer holds', async () => {
    const t = await setup([exec('x1', { language: 'bash', code: 'rm -rf /work/*' }), textStep('I did not run it.')], [verdict('hold', 'the owner did not ask to delete files')]);
    await t.say('list my files');
    expect(t.rows("SELECT decision, rule, reviewerVerdict FROM policy_decisions WHERE toolCallId = 'x1'")).toEqual([
      { decision: 'review', rule: 'risk:exec', reviewerVerdict: 'hold' },
    ]);
    expect(t.requests).toEqual([]);
    expect(t.rows('SELECT id FROM sandbox_execs')).toEqual([]);
    expect(t.rows("SELECT source, riskLevel FROM tool_calls WHERE toolCallId = 'x1'")).toEqual([{ source: 'sandbox', riskLevel: 'exec' }]);
    expect(resultOf(t, 'x1')).toMatch(/^the reviewer held sandbox_exec, and it did not run/);
  });

  it('asks the owner for a call with network access and runs it only after the approval', async () => {
    const t = await setup(
      [exec('n1', { language: 'bash', code: 'pip download requests', network: { allow: ['pypi.org'] } }), textStep('The download waits for you.'), textStep('Done.')],
      [],
    );
    await t.say('download requests from pypi');

    expect(t.rows("SELECT decision, approvalId IS NOT NULL AS asked FROM policy_decisions WHERE toolCallId = 'n1'")).toEqual([{ decision: 'approve', asked: 1 }]);
    const approval = t.rows("SELECT id, status, runId FROM approvals WHERE toolName = 'sandbox_exec'")[0] as { id: number; status: string; runId: string };
    expect(approval.status).toBe('pending');
    // the call waits for the owner, so nothing ran yet.
    expect(t.requests).toEqual([]);
    expect(t.rows('SELECT id FROM sandbox_execs')).toEqual([]);
    expect(t.rows("SELECT source, riskLevel FROM tool_calls WHERE toolCallId = 'n1'")).toEqual([{ source: 'sandbox', riskLevel: 'external' }]);

    await t.app.resolveApproval(approval.id, 'approve', 'dashboard');
    await t.settle();
    await vi.waitFor(() => expect(t.requests).toHaveLength(1));
    expect(t.requests[0]!.network?.networkMode).toBe('okc-net-1');
    expect(t.requests[0]!.env).toEqual(['HTTPS_PROXY=http://okc-proxy:3128']);
    expect(t.closed).toEqual([1]);

    const callId = `approval-${approval.id}`;
    await vi.waitFor(() => expect(t.rows('SELECT status FROM sandbox_execs')).toEqual([{ status: 'ok' }]));
    expect(t.rows('SELECT runId, toolCallId, network, allowlist FROM sandbox_execs')).toEqual([
      { runId: approval.runId, toolCallId: callId, network: 'allowlist', allowlist: '["pypi.org"]' },
    ]);
    await vi.waitFor(() =>
      expect(t.rows('SELECT runId, source, riskLevel, untrustedSource FROM tool_calls WHERE toolCallId = ?', callId)).toEqual([
        { runId: approval.runId, source: 'sandbox', riskLevel: 'external', untrustedSource: 'sandbox:network (pypi.org)' },
      ]),
    );
  });

  it('has no sandbox tool without the sandbox deps, and the app still answers', async () => {
    const t = await setup([textStep('Hello.')], [], {}, false);
    await t.say('hi');
    expect(t.main.calls[0]!.tools.map((tool) => tool.name)).not.toContain(SANDBOX_EXEC);
    expect(t.printed()).toContain('Hello.');
    expect((await t.app.sandbox.status()).available).toBe(false);
  });

  it('offers the tool in the main session when docker answers', async () => {
    const t = await setup([textStep('Hello.')], []);
    await t.say('hi');
    expect(t.main.calls[0]!.tools.map((tool) => tool.name)).toContain(SANDBOX_EXEC);
    expect(await t.app.sandbox.status()).toMatchObject({ available: true, engine: 'docker 28.3.0 (linux/arm64)', network: true });
  });

  it('closes a running row of an earlier process at the start', async () => {
    const db = openDb(':memory:');
    const id = startExec(
      db,
      {
        runId: 'run-old',
        toolCallId: 'c-old',
        sessionKey: 'main',
        taskId: 'task-0',
        language: 'bash',
        command: 'sleep 1000',
        image: SANDBOX_IMAGE,
        cwd: '/work',
        network: 'none',
        allowlist: [],
        limits: DEFAULT_LIMITS,
      },
      new Date('2026-10-17T09:00:00Z'),
    );
    const t = await setup([], [], { db });
    expect(t.rows('SELECT id, status, error, endedAt IS NOT NULL AS ended FROM sandbox_execs')).toEqual([{ id, status: 'error', error: STALE_ERROR, ended: 1 }]);
  });
});
