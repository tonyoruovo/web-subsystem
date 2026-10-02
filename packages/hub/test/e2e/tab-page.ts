/**
 * @fileoverview
 * @summary The app that runs in every tab of the Window-scope gate test (bundled by window.e2e.spec.ts).
 * @description
 * Boots a kernel with the Queue, the NotificationCenter, the Window
 * transport and one window-scoped subsystem (`prefs`), and exposes
 * `window.__e2e` for the test to drive. The relay, when enabled, is the
 * test's server double: publishing calls the `__relayPublish` binding, and
 * the test delivers with `__e2e.relayDeliver`.
 *
 * @author MathAid
 */

import {
  Kernel,
  NO_CONTROL,
  createStore,
  type PacketEnvelope,
  type PacketPort,
  type SubsystemDefinition,
} from '@platform/core';
import { createNotificationCenter } from '@platform/notification';
import { createQueue } from '@platform/queue';

import {
  WINDOW_TRANSPORT_ID,
  createWindowTransport,
  type WindowRelay,
  type WindowTransportControl,
} from '../../src';

interface E2EConfig {
  readonly hubUrl: string | null;
  readonly relay: boolean;
}

declare global {
  interface Window {
    __E2E_CONFIG: E2EConfig;
    __relayPublish?: (windowId: string, envelope: PacketEnvelope) => Promise<void>;
    __e2e: {
      heard: unknown[];
      ready: Promise<void>;
      send(payload: unknown): Promise<void>;
      status(): unknown;
      relayDeliver(windowId: string, envelope: PacketEnvelope): void;
    };
  }
}

const config = window.__E2E_CONFIG;
const heard: unknown[] = [];
const subscribers = new Map<string, (envelope: PacketEnvelope) => void>();

const relay: WindowRelay | undefined = config.relay
  ? {
      publish: (windowId, envelope) => void window.__relayPublish?.(windowId, envelope),
      subscribe(windowId, listener) {
        subscribers.set(windowId, listener);
        return () => void subscribers.delete(windowId);
      },
      connected: createStore(true).view,
    }
  : undefined;

let port: PacketPort | undefined;
const prefs: SubsystemDefinition = {
  id: 'prefs',
  scope: 'window',
  kind: 'featurized',
  state: { initial: {} },
  subscribes: ['prefs:changed'],
  init: (ctx) => void (port = ctx.port),
  receive: (packet) => void heard.push(packet.take()),
  control: () => NO_CONTROL,
};

const notification = createNotificationCenter();
const queue = createQueue({ fanOut: notification.fanOut });
const kernel = new Kernel(
  [
    queue.subsystem,
    notification.subsystem,
    createWindowTransport({
      hubUrl: config.hubUrl ?? undefined,
      relay,
      timeoutMs: 2000,
      heartbeatMs: 60_000,
    }),
    prefs,
  ],
  { router: queue.router },
);

window.__e2e = {
  heard,
  ready: kernel.start(),
  send: (payload) => port!.send({ eventId: 'prefs:changed', payload }),
  status: () =>
    kernel.unit<WindowTransportControl>(WINDOW_TRANSPORT_ID).control?.views.state.getSnapshot(),
  relayDeliver: (windowId, envelope) => subscribers.get(windowId)?.(envelope),
};
