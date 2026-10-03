/**
 * @fileoverview
 * @summary A test processor that reads its configuration in `setup` and can refuse a host.
 * @description With `{ refuseWorkers: true }`, setup throws on a worker host, so
 * the runner fails over to the virtual host (ARCHITECTURE §8.7).
 * @author MathAid
 */
import { defineProcessor, type HostKind } from '../../src';

/** @summary The configuration of the test processor. */
export interface ConfiguredConfig {
  /** @summary A label that `handle` returns, to prove the config arrived. */
  readonly label: string;
  /** @summary Makes `setup` throw on worker hosts. */
  readonly refuseWorkers?: boolean;
}

let config: ConfiguredConfig | undefined;
let host: HostKind | undefined;

/** @summary Returns the label from the config, and the host that ran the call. */
export const configured = defineProcessor<null, { label: string | null; host: string | null }>({
  setup(scope, value) {
    config = value as ConfiguredConfig | undefined;
    host = scope.host;
    if (config?.refuseWorkers && scope.host !== 'virtual') {
      throw new Error(`The ${scope.host} host is refused by its config.`);
    }
  },
  handle: () => ({ label: config?.label ?? null, host: host ?? null }),
});
