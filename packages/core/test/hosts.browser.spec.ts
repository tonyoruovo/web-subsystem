/**
 * M2 gate (docs/PLAN.md): one processor runs on all three hosts with
 * identical results, and each failover trigger is tested, with real workers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProcessorRunner, WorkerBudget, type HostKind, type ProcessorDef } from '../src';

import { configured, type ConfiguredConfig } from './browser/configured.processor';
import { doubler, type DoublerInput } from './browser/doubler.processor';

const dedicatedWorker = () =>
  new Worker(new URL('./browser/doubler.worker.ts', import.meta.url), { type: 'module' });

const sharedWorker = () =>
  new SharedWorker(new URL('./browser/doubler.worker.ts', import.meta.url), {
    type: 'module',
    name: `doubler-${crypto.randomUUID()}`, // a fresh worker per test
  });

const runners: ProcessorRunner<DoublerInput, number | string>[] = [];

function runner(overrides: Partial<ProcessorDef<DoublerInput, number | string>>) {
  const r = new ProcessorRunner<DoublerInput, number | string>(
    {
      id: 'doubler',
      job: 'sink',
      hosts: ['virtual'],
      load: async () => doubler,
      dedicated: dedicatedWorker,
      shared: sharedWorker,
      handshakeTimeoutMs: 5_000,
      ...overrides,
    },
    { budget: new WorkerBudget(4) },
  );
  runners.push(r);
  return r;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(runners.splice(0).map((r) => r.stop()));
});

describe('one processor on every host', () => {
  const inputs = [0, 1, 2, 21, -7, 0.5];

  it('gives identical results on shared, dedicated and virtual hosts', async () => {
    const results: Partial<Record<HostKind, unknown[]>> = {};
    for (const kind of ['shared', 'dedicated', 'virtual'] as const) {
      const r = runner({ hosts: kind === 'virtual' ? ['virtual'] : [kind, 'virtual'] });
      await r.start();
      // SharedWorker is not in every browser; there the runner must fall back, not fail.
      const expected = kind === 'shared' && typeof SharedWorker !== 'function' ? 'virtual' : kind;
      expect(r.status.getSnapshot().host).toBe(expected);
      await expect(r.call('where')).resolves.toBe(expected);
      results[kind] = await Promise.all(inputs.map((n) => r.call(n)));
    }
    expect(results.shared).toEqual(results.virtual);
    expect(results.dedicated).toEqual(results.virtual);
    expect(results.virtual).toEqual(inputs.map((n) => n * 2));
  });
});

describe('failover triggers', () => {
  it('1. unavailable: falls back when SharedWorker does not exist', async () => {
    vi.stubGlobal('SharedWorker', undefined);
    const r = runner({ hosts: ['shared', 'virtual'] });
    await r.start();
    expect(r.status.getSnapshot()).toMatchObject({
      host: 'virtual',
      failovers: [{ host: 'shared', trigger: 'unavailable' }],
    });
    await expect(r.call(4)).resolves.toBe(8);
  });

  it('2. error: falls back when the worker fails while loading', async () => {
    const r = runner({
      hosts: ['dedicated', 'virtual'],
      dedicated: () =>
        new Worker(new URL('./browser/crash.worker.ts', import.meta.url), { type: 'module' }),
    });
    await r.start();
    expect(r.status.getSnapshot()).toMatchObject({
      host: 'virtual',
      failovers: [{ host: 'dedicated', trigger: 'error' }],
    });
  });

  it('3. handshake-timeout: falls back when the worker never answers', async () => {
    const r = runner({
      hosts: ['dedicated', 'virtual'],
      handshakeTimeoutMs: 300,
      dedicated: () =>
        new Worker(new URL('./browser/silent.worker.ts', import.meta.url), { type: 'module' }),
    });
    await r.start();
    expect(r.status.getSnapshot()).toMatchObject({
      host: 'virtual',
      failovers: [{ host: 'dedicated', trigger: 'handshake-timeout' }],
    });
  });

  it('4. heartbeat-missed: moves an in-flight call to the next host when the worker freezes', async () => {
    const r = runner({
      hosts: ['dedicated', 'virtual'],
      heartbeat: { dedicated: { intervalMs: 50, timeoutMs: 200 } },
    });
    await r.start();
    expect(r.status.getSnapshot().host).toBe('dedicated');

    // The worker blocks for 1.5 s; pings go unanswered; the call is re-run on the main thread.
    await expect(r.call('freeze')).resolves.toBe('thawed');
    expect(r.status.getSnapshot()).toMatchObject({
      host: 'virtual',
      failovers: [{ host: 'dedicated', trigger: 'heartbeat-missed' }],
    });
  });
});

describe('processor configuration (ARCHITECTURE §8.7)', () => {
  const configuredRunner = (config: ConfiguredConfig, hosts: HostKind[]) => {
    const r = new ProcessorRunner<null, { label: string | null; host: string | null }>(
      {
        id: 'configured',
        job: 'sink',
        hosts,
        config,
        load: async () => configured,
        dedicated: () =>
          new Worker(new URL('./browser/configured.worker.ts', import.meta.url), {
            type: 'module',
          }),
        shared: () =>
          new SharedWorker(new URL('./browser/configured.worker.ts', import.meta.url), {
            type: 'module',
            name: `configured-${crypto.randomUUID()}`,
          }),
      },
      { budget: new WorkerBudget(4) },
    );
    runners.push(r as never);
    return r;
  };

  it('gives the config to setup on every host', async () => {
    for (const host of ['shared', 'dedicated', 'virtual'] as const) {
      const r = configuredRunner(
        { label: `on-${host}` },
        host === 'virtual' ? ['virtual'] : [host, 'virtual'],
      );
      await r.start();
      await expect(r.call(null)).resolves.toEqual({ label: `on-${host}`, host });
    }
  });

  it('fails over when setup refuses a worker host', async () => {
    const r = configuredRunner({ label: 'refusing', refuseWorkers: true }, [
      'shared',
      'dedicated',
      'virtual',
    ]);
    await r.start();
    await expect(r.call(null)).resolves.toEqual({ label: 'refusing', host: 'virtual' });
    expect(r.status.getSnapshot().failovers.map((f) => [f.host, f.trigger])).toEqual([
      ['shared', 'error'],
      ['dedicated', 'error'],
    ]);
  });
});
