/**
 * @fileoverview
 * @summary Test stand-ins for `@platform/hub`: a cookie jar, a relay, and a link.
 * @author MathAid
 */

import { createStore, type PacketEnvelope } from '@platform/core';

import type { CookieJar, HubLink, WindowRelay } from '../src';

/** A cookie jar that keeps name=value pairs, like a browser for one site. */
export function memoryJar(): CookieJar & { writes: string[] } {
  const cookies = new Map<string, string>();
  const writes: string[] = [];
  return {
    writes,
    read: () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    write(cookie) {
      writes.push(cookie);
      const [pair] = cookie.split(';');
      const at = pair.indexOf('=');
      cookies.set(pair.slice(0, at), pair.slice(at + 1));
    },
  };
}

/** An in-memory relay: the server double. Delivers to every other subscriber of the window id. */
export function memoryRelay(): WindowRelay & {
  published: { windowId: string; envelope: PacketEnvelope }[];
  setConnected(connected: boolean): void;
} {
  const subscribers = new Map<string, Set<(envelope: PacketEnvelope) => void>>();
  const connected = createStore(true);
  const published: { windowId: string; envelope: PacketEnvelope }[] = [];
  return {
    published,
    connected: connected.view,
    setConnected: (value) => connected.set(value),
    publish(windowId, envelope) {
      published.push({ windowId, envelope });
      for (const listener of subscribers.get(windowId) ?? []) listener(structuredClone(envelope));
    },
    subscribe(windowId, listener) {
      const set = subscribers.get(windowId) ?? new Set();
      subscribers.set(windowId, set);
      set.add(listener);
      return () => void set.delete(listener);
    },
  };
}

/** A link whose hub is a shared in-memory bus, with a controllable partition id and liveness. */
export function fakeLink(
  bus: Set<(envelope: unknown) => void>,
  partitionId: string | null,
): HubLink & { opens: number; alive: boolean; failOpen: boolean } {
  let current: ((envelope: unknown) => void) | null = null;
  const link = {
    opens: 0,
    alive: true,
    failOpen: false,
    async open(onEnvelope: (envelope: unknown) => void) {
      link.opens += 1;
      if (link.failOpen) throw new Error('hub down');
      if (current) bus.delete(current);
      current = onEnvelope;
      bus.add(onEnvelope);
      return { partitionId };
    },
    publish(envelope: PacketEnvelope) {
      for (const listener of bus) if (listener !== current) listener(structuredClone(envelope));
    },
    async ping() {
      if (!link.alive) throw new Error('no pong');
    },
    close() {
      if (current) bus.delete(current);
      current = null;
    },
  };
  return link;
}
