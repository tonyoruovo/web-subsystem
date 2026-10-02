import {
  Kernel,
  NO_CONTROL,
  type StatePersistence,
  type SubsystemDefinition,
} from '@platform/core';
import { createMemoryPersistence, createTestPlatform } from '@platform/core/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  CONSENT_CHANGED,
  CONSENT_ID,
  createConsent,
  isConsentGranted,
  type ConsentChange,
  type ConsentControl,
  type ConsentOptions,
} from '../src';

async function setup(options: ConsentOptions = {}, persistence?: StatePersistence) {
  const heard: ConsentChange[][] = [];
  const analytics: SubsystemDefinition = {
    id: 'analytics',
    scope: 'tab',
    kind: 'featurized',
    state: { initial: {} },
    subscribes: [CONSENT_CHANGED],
    receive: (packet) => void heard.push(packet.take() as ConsentChange[]),
    control: () => NO_CONTROL,
  };
  const platform = createTestPlatform([createConsent({ now: () => 5, ...options }), analytics], {
    persistence,
  });
  await platform.start();
  const consent = platform.unit<ConsentControl>(CONSENT_ID).control!;
  return { platform, consent, heard };
}

describe('Consent', () => {
  it('fails closed, keeps necessary granted, and broadcasts each change', async () => {
    const { platform, consent, heard } = await setup();
    const { commands, views } = consent;
    expect(commands.isGranted('necessary')).toBe(true);
    expect(commands.isGranted('analytics')).toBe(false);
    expect(commands.isGranted('unknown')).toBe(false);

    expect(commands.grant('analytics')).toBe(true);
    expect(commands.grant('analytics')).toBe(false); // already granted
    expect(commands.revoke('necessary')).toBe(false);
    expect(commands.isGranted('necessary')).toBe(true);
    await platform.settle();

    expect(heard).toEqual([
      [{ category: 'analytics', granted: true, timestamp: 5, policyVersion: 1 }],
    ]);
    expect(views.grants.getSnapshot()).toEqual({
      necessary: true,
      functional: false,
      analytics: true,
      marketing: false,
    });
    expect(views.pending.getSnapshot()).toEqual(['functional', 'marketing']);
  });

  it('records an explicit no, which clears pending without a broadcast', async () => {
    const { platform, consent, heard } = await setup();
    expect(consent.commands.set({ functional: false, marketing: false })).toEqual([]);
    await platform.settle();
    expect(heard).toEqual([]);
    expect(consent.views.pending.getSnapshot()).toEqual(['analytics']);
  });

  it('grants and revokes everything in one broadcast each', async () => {
    const { platform, consent, heard } = await setup();
    expect(consent.commands.grantAll().map((c) => c.category)).toEqual([
      'functional',
      'analytics',
      'marketing',
    ]);
    expect(consent.commands.revokeAll()).toHaveLength(3);
    await platform.settle();
    expect(heard.map((changes) => changes.length)).toEqual([3, 3]);
    expect(consent.views.grants.getSnapshot().necessary).toBe(true);
    expect(consent.views.pending.getSnapshot()).toEqual([]);
  });

  it('refuses unknown categories, and categories without necessary', async () => {
    const { consent } = await setup();
    expect(() => consent.commands.grant('telepathy')).toThrow(RangeError);
    expect(() => createConsent({ categories: ['analytics'] })).toThrow('necessary');
  });

  it('persists decisions, and asks again when the policy version changes', async () => {
    const persistence = createMemoryPersistence();
    const first = await setup({}, persistence);
    first.consent.commands.set({ functional: true, analytics: true, marketing: false });
    await first.platform.stop();

    const same = await setup({}, persistence);
    expect(same.consent.commands.isGranted('analytics')).toBe(true);
    expect(same.consent.views.pending.getSnapshot()).toEqual([]);
    await same.platform.stop();

    const next = await setup({ policyVersion: 2 }, persistence);
    expect(next.consent.commands.isGranted('analytics')).toBe(false);
    expect(next.consent.views.pending.getSnapshot()).toEqual([
      'functional',
      'analytics',
      'marketing',
    ]);
    // Declining under the new policy records the decision; nothing effective changed.
    expect(next.consent.commands.revoke('analytics')).toBe(false);
    expect(next.consent.views.pending.getSnapshot()).toEqual(['functional', 'marketing']);
  });

  it('reports a broadcast the router refuses, keeping the change', async () => {
    const errors: unknown[] = [];
    const kernel = new Kernel([createConsent()], {
      router: () => ({ route: () => Promise.reject(new Error('refused')) }),
      onError: (error) => errors.push(error),
    });
    await kernel.start();
    const control = kernel.unit<ConsentControl>(CONSENT_ID).control!;
    expect(control.commands.grant('analytics')).toBe(true);
    await vi.waitFor(() => expect(errors).toEqual([new Error('refused')]));
    expect(control.commands.isGranted('analytics')).toBe(true);
  });
});

describe('isConsentGranted', () => {
  it('applies the rule', () => {
    const record = { category: 'analytics', granted: true, timestamp: 0, policyVersion: 1 };
    expect(isConsentGranted({ analytics: record }, 'analytics', 1)).toBe(true);
    expect(isConsentGranted({ analytics: record }, 'analytics', 2)).toBe(false);
    expect(isConsentGranted({ analytics: { ...record, granted: false } }, 'analytics', 1)).toBe(
      false,
    );
    expect(isConsentGranted({}, 'necessary', 9)).toBe(true);
  });
});
