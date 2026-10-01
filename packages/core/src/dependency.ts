/**
 * @fileoverview
 * @summary Dependencies between units: the graph, its validation and boot order.
 * @description
 * Implements docs/ARCHITECTURE.md §7.1. Dependencies are declared per unit,
 * so the graph's nodes are subsystems **and** features (`subsystem/feature`).
 * A cycle between subsystems is fine as long as no cycle exists between the
 * units themselves.
 *
 * - Only **required** dependencies can form a cycle; optional ones only order the boot.
 * - A required dependency on a unit that is not registered is not an error:
 *   the dependent unit stays off (the "optional peer dependency not installed" case).
 * - Every feature implicitly depends on its parent being `INITIALIZING`.
 *
 * @author MathAid
 */

/** @summary A dependency on a subsystem (`id`) or a feature (`id/feature`). */
export interface Dependency {
  readonly target: string;
  /** `required`: the unit stays off without it. `optional`: it runs with reduced behaviour. Default `required`. */
  readonly kind?: 'required' | 'optional';
  /** The status the target must reach. Default `READY`. */
  readonly when?: 'READY' | 'INITIALIZING';
}

/** @summary A unit as the graph sees it. */
export interface DependencyNode {
  readonly id: string;
  readonly requires: readonly Dependency[];
}

/** @summary Thrown when required dependencies form a cycle. */
export class DependencyCycleError extends Error {
  override readonly name = 'DependencyCycleError';
  constructor(readonly cycle: readonly string[]) {
    super(`Required dependencies form a cycle: ${cycle.join(' -> ')}.`);
  }
}

/** @summary True when `dependency` is required. */
export function isRequired(dependency: Dependency): boolean {
  return (dependency.kind ?? 'required') === 'required';
}

/**
 * @summary The dependency graph of every registered unit.
 *
 * @example
 * ```ts
 * const graph = new DependencyGraph([
 *   { id: 'storage', requires: [] },
 *   { id: 'auth', requires: [{ target: 'storage' }] },
 * ]);
 * graph.validate();
 * graph.order(); // ['storage', 'auth']
 * ```
 */
export class DependencyGraph {
  readonly #nodes = new Map<string, DependencyNode>();

  constructor(nodes: Iterable<DependencyNode>) {
    for (const node of nodes) {
      if (this.#nodes.has(node.id)) throw new Error(`Unit "${node.id}" is registered twice.`);
      this.#nodes.set(node.id, node);
    }
  }

  /** @summary True when a unit with this id is registered. */
  has(id: string): boolean {
    return this.#nodes.has(id);
  }

  /** @summary Required targets of `id` that are not registered: the unit can never start. */
  missing(id: string): string[] {
    return (this.#nodes.get(id)?.requires ?? [])
      .filter((d) => isRequired(d) && !this.#nodes.has(d.target))
      .map((d) => d.target);
  }

  /**
   * @summary Rejects cycles of required dependencies.
   * @throws {DependencyCycleError} With the ids along the cycle.
   */
  validate(): void {
    const state = new Map<string, 'visiting' | 'done'>();
    const stack: string[] = [];

    const visit = (id: string): void => {
      state.set(id, 'visiting');
      stack.push(id);
      for (const dependency of this.#nodes.get(id)!.requires) {
        if (!isRequired(dependency) || !this.#nodes.has(dependency.target)) continue;
        const target = dependency.target;
        if (state.get(target) === 'visiting') {
          throw new DependencyCycleError([...stack.slice(stack.indexOf(target)), target]);
        }
        if (!state.has(target)) visit(target);
      }
      stack.pop();
      state.set(id, 'done');
    };

    for (const id of this.#nodes.keys()) if (!state.has(id)) visit(id);
  }

  /**
   * @summary A deterministic boot order: dependencies first, then registration order.
   * @description
   * Honours optional dependencies too, unless they would form a cycle, in
   * which case only required dependencies decide the order.
   *
   * @returns {string[]} Every registered id.
   * @throws {DependencyCycleError} When required dependencies form a cycle.
   */
  order(): string[] {
    this.validate();
    return this.#topologicalOrder(true) ?? this.#topologicalOrder(false)!;
  }

  /** Kahn's algorithm, picking the earliest-registered ready node. `null` on a cycle. */
  #topologicalOrder(withOptional: boolean): string[] | null {
    const ids = [...this.#nodes.keys()];
    const pending = new Map<string, Set<string>>();
    for (const id of ids) {
      const deps = this.#nodes
        .get(id)!
        .requires.filter((d) => (withOptional || isRequired(d)) && this.#nodes.has(d.target))
        .map((d) => d.target);
      pending.set(id, new Set(deps));
    }

    const order: string[] = [];
    while (order.length < ids.length) {
      const next = ids.find((id) => !order.includes(id) && pending.get(id)!.size === 0);
      if (next === undefined) return null;
      order.push(next);
      for (const deps of pending.values()) deps.delete(next);
    }
    return order;
  }
}

/**
 * @summary Buffers writes for a dependency that is not ready yet (§7.2).
 * @description
 * Before `bind`, writes are kept in a bounded buffer; on overflow the oldest
 * entry is dropped and counted. `bind` drains the buffer in order, then
 * passes writes straight through. `unbind` (the target left `READY`) goes
 * back to buffering. This one mechanism covers the Logger ring buffer, the
 * Queue's dead letters and Global State restoration.
 *
 * @example
 * ```ts
 * const logs = new LateBinding<string>({ capacity: 500 });
 * logs.write('boot'); // buffered: storage is not ready
 * await logs.bind((line) => storage.append(line)); // drains 'boot', then writes go straight through
 * ```
 */
export class LateBinding<T> {
  readonly #buffer: T[] = [];
  #sink: ((item: T) => void | Promise<void>) | null = null;
  #draining = false;
  #dropped = 0;

  constructor(
    private readonly options: {
      readonly capacity: number;
      /** Called for each dropped item, with the running total. */
      readonly onDrop?: (item: T, totalDropped: number) => void;
    },
  ) {
    if (options.capacity < 1) throw new RangeError('LateBinding capacity must be at least 1.');
  }

  /** @summary How many items wait in the buffer. */
  get buffered(): number {
    return this.#buffer.length;
  }

  /** @summary How many items were dropped on overflow. */
  get dropped(): number {
    return this.#dropped;
  }

  /** @summary True when writes pass straight to the sink. */
  get bound(): boolean {
    return this.#sink !== null && !this.#draining;
  }

  /**
   * @summary Writes an item: to the sink when bound, otherwise to the buffer.
   * @returns The sink's result when bound.
   */
  write(item: T): void | Promise<void> {
    if (this.bound) return this.#sink!(item);
    this.#buffer.push(item);
    if (this.#buffer.length > this.options.capacity) {
      const dropped = this.#buffer.shift()!;
      this.#dropped += 1;
      this.options.onDrop?.(dropped, this.#dropped);
    }
  }

  /**
   * @summary Binds the sink and drains the buffer in order.
   * @description
   * Writes that arrive while draining are queued behind the buffered ones. If
   * the sink fails, the failed item stays at the front of the buffer, the
   * binding is undone, and the error is rethrown.
   */
  async bind(sink: (item: T) => void | Promise<void>): Promise<void> {
    this.#sink = sink;
    this.#draining = true;
    try {
      while (this.#buffer.length > 0) {
        await sink(this.#buffer[0]);
        this.#buffer.shift();
      }
    } catch (error) {
      this.#sink = null;
      throw error;
    } finally {
      this.#draining = false;
    }
  }

  /** @summary Goes back to buffering, for example when the target leaves `READY`. */
  unbind(): void {
    this.#sink = null;
  }
}
