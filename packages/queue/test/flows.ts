/**
 * @fileoverview
 * @summary The M3 gate scenario: the README's 1-to-1 and 1-to-many flows, end to end.
 * @description
 * Shared by `flows.spec.ts` (Node) and `flows.browser.spec.ts` (every
 * installed browser). It boots the three centralized subsystems with the
 * real scheduler, then:
 *
 * ```text
 *   1-to-1    auth --request storage:get--> Queue --> storage --reply--> auth
 *   1-to-many auth --broadcast auth:login--> Queue --> Notification Center --> audit, analytics, ui
 *   ```
 *
 * and checks every trail, the counters, and that Global State's pending
 * work is empty afterwards.
 *
 * @author MathAid
 */

import {
  Kernel,
  NO_CONTROL,
  makeFingerprint,
  type FingerprintTrail,
  type PacketPort,
  type SubsystemDefinition,
} from '@platform/core';
import {
  GLOBAL_STATE_ID,
  createGlobalState,
  type EnvironmentSource as GlobalEnvironment,
  type GlobalStateControl,
} from '@platform/global-state';
import {
  NOTIFICATION_ID,
  createNotificationCenter,
  type NotificationControl,
} from '@platform/notification';
import { expect, vi } from 'vitest';

import { QUEUE_ID, createQueue, type QueueControl } from '../src';

/** `action:subsystem[/component]` for each entry. */
const read = (trail: FingerprintTrail) =>
  trail.entries.map(
    (e) => `${e.actionName}:${e.subsystemId}${e.componentId ? `/${e.componentId}` : ''}`,
  );

/**
 * @summary Runs both flows and asserts their trails.
 * @param {GlobalEnvironment} environment Global State's environment source.
 */
export async function runFlows(environment: GlobalEnvironment): Promise<void> {
  let auth: PacketPort | undefined;
  const heard: Record<string, FingerprintTrail> = {};

  const subscriber = (id: string, scope: 'page' | 'tab'): SubsystemDefinition => ({
    id,
    scope,
    kind: 'featurized',
    state: { initial: {} },
    subscribes: ['auth:login'],
    receive: (packet) => {
      expect(packet.take()).toEqual({ user: 'ada' });
      heard[id] = packet.header.fingerprints;
    },
    control: () => NO_CONTROL,
  });

  const subsystems: SubsystemDefinition[] = [
    {
      id: 'storage',
      scope: 'tab',
      kind: 'featurized',
      state: { initial: {} },
      receive: (packet) => {
        const { key } = packet.take() as { key: string };
        packet.stamp(makeFingerprint('storage', 'read', { componentId: 'idb' }));
        return { key, value: 42 };
      },
      control: () => NO_CONTROL,
    },
    {
      id: 'auth',
      scope: 'tab',
      kind: 'featurized',
      state: { initial: {} },
      requires: [{ target: 'storage' }],
      init: (ctx) => {
        auth = ctx.port;
      },
      control: () => NO_CONTROL,
    },
    subscriber('audit', 'tab'),
    subscriber('analytics', 'page'),
  ];

  const notification = createNotificationCenter({
    events: [{ eventId: 'auth:login', publishers: ['auth'] }],
  });
  const queue = createQueue({ fanOut: notification.fanOut });
  const kernel = new Kernel(
    [
      createGlobalState({ environment, tabIdentity: false }),
      queue.subsystem,
      notification.subsystem,
      ...subsystems,
    ],
    { router: queue.router },
  );
  await kernel.start();

  const queueControl = kernel.unit<QueueControl>(QUEUE_ID).control!;
  const notificationControl = kernel.unit<NotificationControl>(NOTIFICATION_ID).control!;
  const globalState = kernel.unit<GlobalStateControl>(GLOBAL_STATE_ID).control!;
  const ui = vi.fn();
  notificationControl.commands.subscribe('auth:login', ui, { subscriber: 'ui' });

  // 1-to-1
  const reply = await auth!.request({
    eventId: 'storage:get',
    payload: { key: 'user' },
    target: 'storage',
  });
  expect(reply).toEqual({ key: 'user', value: 42 });
  const request = queueControl.views.trails.getSnapshot()[0];
  expect(request).toMatchObject({ outcome: 'completed', source: 'auth', target: 'storage' });
  expect(read(request.trail)).toEqual([
    'sent:auth',
    'enqueued:queue',
    'dispatched:queue',
    'delivered:storage',
    'read:storage/idb',
    'completed:queue',
  ]);
  expect(request.trail.dropped).toBe(0);

  // 1-to-many
  await auth!.send({ eventId: 'auth:login', payload: { user: 'ada' } });
  expect(ui).toHaveBeenCalledWith(
    { user: 'ada' },
    expect.objectContaining({ eventId: 'auth:login' }),
  );
  const route = ['sent:auth', 'enqueued:queue', 'dispatched:queue', 'fanned-out:notification'];
  expect(read(heard.audit)).toEqual([...route, 'delivered:audit']);
  expect(read(heard.analytics)).toEqual([...route, 'delivered:analytics']);

  const [broadcast] = notificationControl.views.history.getSnapshot();
  expect(broadcast.traceId).not.toBe(request.traceId);
  expect(read(broadcast.trail)).toEqual([
    ...route,
    'delivered:notification/audit',
    'delivered:notification/analytics',
    'delivered:notification/ui',
  ]);
  expect(queueControl.views.trails.getSnapshot()[1]).toMatchObject({
    outcome: 'completed',
    target: null,
  });

  expect(queueControl.views.state.getSnapshot()).toMatchObject({
    depth: 0,
    inFlight: 0,
    completed: 2,
    failed: 0,
    rejected: 0,
  });
  await vi.waitFor(() => expect(globalState.views.state.getSnapshot().pending).toEqual([]));
  await kernel.stop();
}
