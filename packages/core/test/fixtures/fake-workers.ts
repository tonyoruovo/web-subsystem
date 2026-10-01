/**
 * Fake Worker / SharedWorker for Node tests: a real MessageChannel with
 * `serveProcessor` on the other end, plus switches for each failure mode.
 */
import type { ProcessorModule } from '../../src';
import { serveProcessor, type WorkerScopeLike } from '../../src/worker';

export interface FakeWorkerBehaviour {
  /** Serve this module on the worker side. Omit to never answer (handshake timeout). */
  readonly module?: ProcessorModule<never, unknown>;
  /** Drop ping requests on the way in (heartbeat missed). */
  readonly dropPings?: boolean;
}

/** Messages from the main thread to the worker, as plain objects. */
const isPing = (message: unknown) =>
  typeof message === 'object' && message !== null && (message as { op?: string }).op === 'ping';

export class FakeWorker extends EventTarget {
  readonly #port: MessagePort;
  terminated = false;

  constructor(behaviour: FakeWorkerBehaviour = {}) {
    super();
    const { port1, port2 } = new MessageChannel();
    this.#port = port1;
    if (behaviour.module) {
      serveProcessor(behaviour.module, { scope: port2 as unknown as WorkerScopeLike });
    }
    const send = port1.postMessage.bind(port1);
    this.postMessage = (message: unknown) => {
      if (behaviour.dropPings && isPing(message)) return;
      send(message);
    };
  }

  postMessage: (message: unknown) => void;

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void {
    if (type === 'message' || type === 'messageerror') {
      this.#port.addEventListener(type, listener as EventListener);
    } else super.addEventListener(type, listener);
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void {
    if (type === 'message' || type === 'messageerror') {
      this.#port.removeEventListener(type, listener as EventListener);
    } else super.removeEventListener(type, listener);
  }

  start(): void {
    this.#port.start();
  }

  /** Simulates an uncaught error inside the worker. */
  crash(message = 'worker crashed'): void {
    this.dispatchEvent(Object.assign(new Event('error'), { message }));
  }

  terminate(): void {
    this.terminated = true;
    this.#port.close();
  }
}

export class FakeSharedWorker extends EventTarget {
  readonly port: MessagePort;

  constructor(behaviour: FakeWorkerBehaviour = {}) {
    super();
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    if (behaviour.module) {
      // A shared worker scope: one connect event with the tab's port.
      const scope = {
        onconnect: null,
        addEventListener(type: string, listener: (event: MessageEvent) => void) {
          if (type === 'connect') listener({ ports: [port2] } as unknown as MessageEvent);
        },
      } as unknown as WorkerScopeLike;
      serveProcessor(behaviour.module, { scope });
    }
  }

  crash(message = 'shared worker crashed'): void {
    this.dispatchEvent(Object.assign(new Event('error'), { message }));
  }
}
