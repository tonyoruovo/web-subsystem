import { describe, expect, it } from 'vitest';

import { SyncManager, type OfflineChange, type SyncConflict } from '../src';

describe('SyncManager', () => {
  it('pushes offline changes and clears the queue', async () => {
    const pushed: OfflineChange[] = [];
    const sync = new SyncManager({
      push: async (changes) => {
        pushed.push(...changes);
      },
    });

    sync.recordChange('UPDATE', 'e1', { n: 1 });
    sync.recordChange('UPDATE', 'e2', { n: 2 });
    await sync.syncNow();

    expect(pushed).toHaveLength(2);
    expect(sync.getPendingSyncCount()).toBe(0);
    expect(sync.getStatus()).toBe('IDLE');
  });

  it('sets status ERROR when push fails', async () => {
    const sync = new SyncManager({
      push: async () => {
        throw new Error('network down');
      },
    });
    sync.recordChange('UPDATE', 'e1', { n: 1 });

    await expect(sync.syncNow()).rejects.toThrow('network down');
    expect(sync.getStatus()).toBe('ERROR');
    expect(sync.getPendingSyncCount()).toBe(1); // not cleared on failure
  });

  it('detects conflicts and resolves them', async () => {
    const sync = new SyncManager({
      pull: async () => ({ e1: { n: 5 } }),
      detectConflicts: (changes, remote) => {
        const conflicts: SyncConflict[] = [];
        for (const c of changes) {
          if (
            c.operation === 'UPDATE' &&
            remote[c.entityId] !== undefined &&
            JSON.stringify(remote[c.entityId]) !== JSON.stringify(c.data)
          ) {
            conflicts.push({
              id: `conflict-${c.entityId}`,
              entityId: c.entityId,
              local: c.data,
              remote: remote[c.entityId],
            });
          }
        }
        return conflicts;
      },
    });

    sync.recordChange('UPDATE', 'e1', { n: 1 });
    await sync.syncNow();

    expect(sync.getStatus()).toBe('CONFLICT');
    expect(sync.getConflicts()).toHaveLength(1);

    expect(sync.resolveConflict('conflict-e1', 'CLIENT_WINS')).toEqual({ n: 1 });
    expect(sync.getConflicts()).toHaveLength(0);
  });

  it('merges on MERGE resolution', async () => {
    const sync = new SyncManager({
      pull: async () => ({ e1: { a: 1 } }),
      detectConflicts: () => [{ id: 'c1', entityId: 'e1', local: { b: 2 }, remote: { a: 1 } }],
    });
    sync.recordChange('UPDATE', 'e1', { b: 2 });
    await sync.syncNow();

    expect(sync.resolveConflict('c1', 'MERGE')).toEqual({ a: 1, b: 2 });
  });

  it('records the last sync time', async () => {
    let now = 0;
    const sync = new SyncManager({ now: () => now });
    sync.recordChange('CREATE', 'e1', {});
    now = 500;
    await sync.syncNow();

    expect(sync.getLastSyncAt()).toBe(500);
  });

  it('coalesces concurrent sync calls (exactly once)', async () => {
    let pushes = 0;
    const sync = new SyncManager({
      push: async () => {
        pushes += 1;
        await new Promise((r) => setTimeout(r, 5));
      },
    });
    sync.recordChange('UPDATE', 'e1', { n: 1 });

    await Promise.all([sync.syncNow(), sync.syncNow(), sync.syncNow()]);

    expect(pushes).toBe(1);
  });

  it('passes the last sync time to pull for delta sync', async () => {
    const sinceValues: Array<number | null> = [];
    const sync = new SyncManager({
      now: () => 0,
      pull: async (since) => {
        sinceValues.push(since);
        return {};
      },
    });

    await sync.syncNow();
    expect(sinceValues).toEqual([null]);

    await sync.syncNow();
    expect(sinceValues).toEqual([null, 0]); // second pull receives the last sync time
  });
});
