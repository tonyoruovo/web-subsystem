import { describe, expect, it } from 'vitest';

import { optimisticUpdate, SettingsManager, type ConsentSurface } from '../src';

function makeConsent(): ConsentSurface & { grants: Map<string, boolean> } {
  const grants = new Map<string, boolean>();
  return {
    grants,
    isGranted: (c) => grants.get(c) ?? false,
    grant: (c) => grants.set(c, true),
    revoke: (c) => grants.set(c, false),
  };
}

describe('SettingsManager', () => {
  it('holds default settings', () => {
    const settings = new SettingsManager();
    expect(settings.getSettings()).toEqual({
      syncInterval: 300_000,
      bandwidthMode: 'FULL',
      dataSaver: false,
    });
  });

  it('updates settings live', () => {
    const settings = new SettingsManager();
    settings.setSyncInterval(60_000);
    settings.setBandwidthMode('MINIMAL');
    settings.setDataSaver(true);

    expect(settings.getSettings()).toEqual({
      syncInterval: 60_000,
      bandwidthMode: 'MINIMAL',
      dataSaver: true,
    });
  });

  it('delegates analytics opt-out to consent', () => {
    const consent = makeConsent();
    const settings = new SettingsManager({ consent });

    expect(settings.isAnalyticsEnabled()).toBe(false);
    settings.enableAnalytics();
    expect(settings.isAnalyticsEnabled()).toBe(true);
    settings.disableAnalytics();
    expect(settings.isAnalyticsEnabled()).toBe(false);
  });
});

describe('optimisticUpdate', () => {
  it('applies and commits on success', async () => {
    const calls: string[] = [];
    await optimisticUpdate(
      () => {
        calls.push('apply');
      },
      () => {
        calls.push('commit');
      },
      () => {
        calls.push('rollback');
      },
    );

    expect(calls).toEqual(['apply', 'commit']);
  });

  it('rolls back and rethrows on failure', async () => {
    const calls: string[] = [];
    await expect(
      optimisticUpdate(
        () => {
          calls.push('apply');
        },
        () => {
          calls.push('commit');
          throw new Error('boom');
        },
        () => {
          calls.push('rollback');
        },
      ),
    ).rejects.toThrow('boom');

    expect(calls).toEqual(['apply', 'commit', 'rollback']);
  });
});
