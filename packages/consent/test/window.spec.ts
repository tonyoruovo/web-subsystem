import { Kernel, type Scheduler, type StatePersistence } from '@platform/core';
import { createMemoryPersistence } from '@platform/core/testing';
import {
  WINDOW_TRANSPORT_ID,
  createWindowTransport,
  type WindowTransportControl,
} from '@platform/hub';
import { createNotificationCenter } from '@platform/notification';
import { createQueue } from '@platform/queue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CONSENT_ID, createConsent, type ConsentControl } from '../src';

const scheduler: Scheduler = {
  kind: 'timeout',
  postTask: (task) => Promise.resolve().then(task),
  yield: () => Promise.resolve(),
  idle: (task) => Promise.resolve().then(task),
};

const kernels: Kernel[] = [];
afterEach(async () => {
  for (const kernel of kernels.splice(0)) await kernel.stop();
});

let clock = 1_000;

/** One tab: the centralized subsystems, the Window transport (one origin, one channel), and Consent. */
async function tab(channel: string, persistence?: StatePersistence) {
  const notification = createNotificationCenter();
  const queue = createQueue({ scheduler, fanOut: notification.fanOut });
  const kernel = new Kernel(
    [
      queue.subsystem,
      notification.subsystem,
      createWindowTransport({ channel, origin: 'https://app.test' }),
      createConsent({ now: () => ++clock }),
    ],
    { router: queue.router, persistence },
  );
  kernels.push(kernel);
  await kernel.start();
  await vi.waitFor(() =>
    expect(
      kernel.unit<WindowTransportControl>(WINDOW_TRANSPORT_ID).control!.views.state.getSnapshot()
        .connection,
    ).toBe('connected'),
  );
  return kernel.unit<ConsentControl>(CONSENT_ID).control!;
}

describe('Consent in Window scope', () => {
  it('shares a decision made in one tab with the other tabs', async () => {
    const a = await tab('consent-1');
    const b = await tab('consent-1');
    a.commands.grant('analytics');
    await vi.waitFor(() => expect(b.commands.isGranted('analytics')).toBe(true));

    b.commands.revoke('analytics');
    await vi.waitFor(() => expect(a.commands.isGranted('analytics')).toBe(false));
    expect(a.views.pending.getSnapshot()).toEqual(['functional', 'marketing']);
  });

  it('brings a new tab up to date with the decisions of the open ones', async () => {
    const a = await tab('consent-2', createMemoryPersistence());
    a.commands.set({ functional: true, analytics: false, marketing: false });

    const late = await tab('consent-2', createMemoryPersistence()); // another origin's storage: empty
    await vi.waitFor(() => expect(late.views.pending.getSnapshot()).toEqual([]));
    expect(late.views.grants.getSnapshot()).toMatchObject({ functional: true, analytics: false });
  });
});
