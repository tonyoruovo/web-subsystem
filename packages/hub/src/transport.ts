/**
 * @fileoverview
 * @summary The Window transport subsystem: connects the kernel's Window broadcasts to the other tabs.
 * @description
 * Implements "in the kernel" of docs/ARCHITECTURE.md §11.3.
 *
 * ```text
 *   this tab:   NotificationCenter --(scope relay 'window')--> client.publish --> hub / relay --> other tabs
 *   other tabs: hub / relay --> client.onEnvelope --> Queue.ingest --> NotificationCenter (remote fan-out)
 *   ```
 *
 * The subsystem (id `window`, Tab scope) has no required dependency. It
 * follows the NotificationCenter with `ctx.watch` to attach itself as the
 * Window relay, and hands what arrives to the Queue's `ingest`.
 *
 * @example
 * Registering it
 * ```ts
 * const kernel = new Kernel(
 *   [...centralized, createWindowTransport({ hubUrl: 'https://example.com/__platform/hub.html' }), ...subsystems],
 *   { router: queue.router },
 * );
 * ```
 *
 * @example
 * Showing the reach
 * ```ts
 * const { views } = kernel.unit<WindowTransportControl>('window').control!;
 * views.state.getSnapshot().reach; // 'site' | 'origin' | 'unknown'
 * ```
 *
 * @author MathAid
 */

import {
  defineSubsystem,
  type ControlInterface,
  type PacketEnvelope,
  type ScopeRelay,
  type SubsystemDefinition,
  type View,
} from '@platform/core';

import {
  createWindowClient,
  type WindowClient,
  type WindowClientOptions,
  type WindowStatus,
} from './client';

/**
 * @summary The id the Window transport registers under.
 * @constant {'window'}
 * @public
 */
export const WINDOW_TRANSPORT_ID = 'window';

/**
 * @summary The part of the NotificationCenter's control interface the transport uses.
 * @public
 */
export interface RelayHost extends ControlInterface {
  /**
   * @summary The commands that the transport uses.
   */
  readonly commands: {
    /**
     * @summary Attaches the Window relay.
     * @param {ScopeRelay} relay The relay.
     * @returns {() => void} Detaches the relay.
     */
    attachRelay(relay: ScopeRelay): () => void;
  };
}

/**
 * @summary The part of the Queue's control interface the transport uses.
 * @public
 */
export interface IngestTarget extends ControlInterface {
  /**
   * @summary The commands that the transport uses.
   */
  readonly commands: {
    /**
     * @summary Admits a broadcast from another tab.
     * @param {PacketEnvelope} envelope The broadcast.
     * @returns {Promise<boolean>} `true` after the fan-out, `false` for a repeat.
     */
    ingest(envelope: PacketEnvelope): Promise<boolean>;
  };
}

/**
 * @summary The Window transport's state: the client's status, and counters.
 *
 * @example
 * Example 1: Connected on Chrome
 * ```ts
 * // { mode: 'iframe', connection: 'connected', hub: 'shared', relay: 'none', reach: 'site', windowId: 'w1', sent: 3, received: 5, dropped: 0 }
 * ```
 *
 * @example
 * Example 2: Warning when cross-subdomain delivery is not available
 * ```ts
 * if (state.getSnapshot().reach === 'origin') console.warn('Window scope reaches this origin only.');
 * ```
 *
 * @public
 */
export interface WindowTransportData extends WindowStatus {
  /**
   * @summary The number of Window broadcasts that this tab sent.
   */
  sent: number;
  /**
   * @summary The number of broadcasts from other tabs that the transport gave to the Queue.
   */
  received: number;
  /**
   * @summary The number of broadcasts from other tabs that arrived while the Queue did not run.
   * @description The transport drops these broadcasts.
   */
  dropped: number;
}

/**
 * @summary The Window transport's control interface: its state, and a reconnect command.
 *
 * @example
 * Example 1: A reconnect button
 * ```ts
 * button.onclick = () => commands.reconnect();
 * ```
 *
 * @example
 * Example 2: Watching the connection
 * ```ts
 * views.state.subscribe(() => render(views.state.getSnapshot().connection));
 * ```
 *
 * @public
 */
export interface WindowTransportControl {
  /**
   * @summary The commands of the Window transport.
   */
  readonly commands: {
    /**
     * @summary Connects the client again now.
     * @description Use it after a deployment fixed the hub page, instead of waiting for the backoff.
     * @example
     * A reconnect button
     * ```ts
     * button.onclick = () => commands.reconnect();
     * ```
     * @returns {Promise<void>} Resolves when the link is open.
     * @throws {HubUnavailableError} When the hub does not answer in time.
     */
    reconnect(): Promise<void>;
  };
  /**
   * @summary The views of the Window transport.
   */
  readonly views: {
    /**
     * @summary The state of the transport: the client status and the counters.
     */
    readonly state: View<Partial<WindowTransportData>>;
  };
}

/**
 * @summary Creates the Window transport subsystem.
 *
 * @description
 * Builds a {@linkcode WindowClient} from `options` each time it starts, and
 * connects it without waiting (the client keeps reconnecting in the
 * background, and a failure is reported). Closes it on teardown.
 *
 * @example
 * Example 1: With a hub on the apex
 * ```ts
 * createWindowTransport({ hubUrl: 'https://example.com/__platform/hub.html' });
 * ```
 *
 * @example
 * Example 2: A single-origin app
 * ```ts
 * createWindowTransport({});
 * ```
 *
 * @param {WindowClientOptions} [options] The client's options.
 * @returns {SubsystemDefinition<WindowTransportData, WindowTransportControl>} The subsystem.
 *
 * @public
 */
export function createWindowTransport(
  options: WindowClientOptions = {},
): SubsystemDefinition<WindowTransportData, WindowTransportControl> {
  let client: WindowClient | null = null;
  const readable = { readable: true } as const;

  return defineSubsystem({
    id: WINDOW_TRANSPORT_ID,
    scope: 'tab',
    kind: 'featurized',
    requires: [
      { target: 'queue', kind: 'optional' },
      { target: 'notification', kind: 'optional' },
    ],
    state: {
      initial: {
        mode: 'single-origin',
        connection: 'idle',
        hub: 'unknown',
        relay: 'none',
        reach: 'unknown',
        windowId: null,
        sent: 0,
        received: 0,
        dropped: 0,
      } as WindowTransportData,
      policy: {
        mode: readable,
        connection: readable,
        hub: readable,
        relay: readable,
        reach: readable,
        windowId: readable,
        sent: readable,
        received: readable,
        dropped: readable,
      },
    },
    init(ctx) {
      const current = createWindowClient(options);
      client = current;
      const sync = () =>
        ctx.state.update((s) => void Object.assign(s, current.status.getSnapshot()));
      const stopStatus = current.status.subscribe(sync);
      sync();

      const stopReceiving = current.onEnvelope((envelope) => {
        const queue = ctx.dependency<IngestTarget>('queue');
        if (!queue) {
          ctx.state.update((s) => void s.dropped++);
          return;
        }
        ctx.state.update((s) => void s.received++);
        queue.commands.ingest(envelope).catch((error: unknown) => ctx.report(error));
      });

      let detach: (() => void) | undefined;
      ctx.watch<RelayHost>('notification', (notification) => {
        detach?.();
        detach = notification?.commands.attachRelay({
          scope: 'window',
          publish: (envelope) => {
            current.publish(envelope);
            ctx.state.update((s) => void s.sent++);
          },
        });
      });

      current.connect().catch((error: unknown) => ctx.report(error));
      return () => {
        detach?.();
        stopReceiving();
        stopStatus();
        current.close();
        client = null;
      };
    },
    control: (ctx) => ({
      commands: {
        reconnect: () => client?.connect() ?? Promise.resolve(),
      },
      views: { state: ctx.state.readable },
    }),
  });
}
