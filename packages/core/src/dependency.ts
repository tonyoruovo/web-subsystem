/**
 * @fileoverview
 * @summary Dependencies between units: the graph, its validation, boot order, and late binding.
 * @description
 * Implements docs/ARCHITECTURE.md §7. Dependencies are declared per unit, so
 * the graph's nodes are subsystems **and** features (`subsystem/feature`). A
 * cycle between subsystems is fine as long as no cycle exists between the
 * units themselves.
 *
 * ```text
 *   network  <------------ auth            (auth requires network)
 *     |                      ^
 *     +-- network/interceptor+             (the feature requires auth)
 *   no unit-level cycle: network -> auth -> network/interceptor
 *   ```
 *
 * - Only **required** dependencies can form a cycle; optional ones only order the boot.
 * - A required dependency on a unit that is not registered is not an error:
 *   the dependent unit stays off (the "optional peer dependency not installed" case).
 * - The kernel adds an implicit dependency from every feature to its parent.
 *
 * {@linkcode LateBinding} covers the other side of §7: buffering writes for a
 * dependency that starts later than its user.
 *
 * @example
 * Declaring dependencies on a unit
 * ```ts
 * defineSubsystem({
 *   id: 'sync',
 *   scope: 'tab',
 *   kind: 'featurized',
 *   requires: [
 *     { target: 'network' },
 *     { target: 'storage' },
 *     { target: 'consent', kind: 'optional' },
 *   ],
 *   state: { initial: {} },
 *   control: () => ({ commands: {}, views: {} }),
 * });
 * ```
 *
 * @example
 * Checking a graph outside the kernel
 * ```ts
 * const graph = new DependencyGraph([
 *   { id: 'storage', requires: [] },
 *   { id: 'auth', requires: [{ target: 'storage' }] },
 * ]);
 * graph.order(); // ['storage', 'auth']
 * ```
 *
 * @throws {DependencyCycleError} From {@linkcode DependencyGraph.validate} and {@linkcode DependencyGraph.order} for a required cycle.
 * @author MathAid
 */

/**
 * @summary A dependency on a subsystem (`id`) or a feature (`id/feature`).
 *
 * @description
 * `target` names the unit depended on. `kind` is `required` (the default: the
 * unit stays off without it) or `optional` (the unit runs without it, with
 * reduced behaviour). `when` is the status the target must reach: `READY` (the
 * default, which also accepts `BUSY` and `DEGRADED`) or `INITIALIZING`.
 *
 * Units list their dependencies in `requires`. The kernel starts a unit only
 * once its required dependencies are met, and lets it read them through
 * `ctx.dependency(target)`.
 *
 * @example
 * Example 1: A required subsystem
 * ```ts
 * const dependency: Dependency = { target: 'storage' };
 * ```
 *
 * @example
 * Example 2: An optional feature of another subsystem
 * ```ts
 * const dependency: Dependency = { target: 'network/interceptor', kind: 'optional' };
 * ```
 *
 * @public
 */
export interface Dependency {
  /**
   * @summary The id of the unit that is needed: `subsystem` or `subsystem/feature`.
   */
  readonly target: string;
  /**
   * @summary How much the unit needs the target.
   * @description With `required`, the unit stays off without the target. With
   * `optional`, the unit runs with less behavior. The default is `required`.
   */
  readonly kind?: 'required' | 'optional';
  /**
   * @summary The status that the target must have.
   * @description The default is `READY`. Use `INITIALIZING` for a unit that
   * must start while its target starts.
   */
  readonly when?: 'READY' | 'INITIALIZING';
}

/**
 * @summary A unit as the dependency graph sees it: an id and its dependencies.
 *
 * @example
 * Example 1: A subsystem node
 * ```ts
 * const node: DependencyNode = { id: 'auth', requires: [{ target: 'storage' }] };
 * ```
 *
 * @example
 * Example 2: A feature node, with the implicit parent edge the kernel adds
 * ```ts
 * const node: DependencyNode = {
 *   id: 'storage/idb',
 *   requires: [{ target: 'storage', when: 'INITIALIZING' }],
 * };
 * ```
 *
 * @public
 */
export interface DependencyNode {
  /**
   * @summary The full id of the unit.
   */
  readonly id: string;
  /**
   * @summary The dependencies of the unit.
   */
  readonly requires: readonly Dependency[];
}

/**
 * @summary Thrown when required dependencies form a cycle.
 *
 * @description
 * `cycle` lists the ids along the cycle, starting and ending with the same
 * id. The kernel throws it from its constructor, before anything starts.
 *
 * @example
 * Example 1: Printing the cycle
 * ```ts
 * try {
 *   new Kernel(subsystems);
 * } catch (error) {
 *   if (error instanceof DependencyCycleError) console.error(error.cycle.join(' -> '));
 * }
 * ```
 *
 * @example
 * Example 2: The message
 * ```ts
 * new DependencyCycleError(['a', 'b', 'a']).message;
 * // 'Required dependencies form a cycle: a -> b -> a.'
 * ```
 *
 * @public
 */
export class DependencyCycleError extends Error {
  /**
   * @summary The name of the error class: `'DependencyCycleError'`.
   */
  override readonly name = 'DependencyCycleError';

  /**
   * @summary Creates the error for one cycle.
   * @param {readonly string[]} cycle The ids along the cycle. The first id is repeated at the end.
   */
  constructor(
    /**
     * @summary The ids along the cycle, for example `['a', 'b', 'a']`.
     * @description The first id is repeated at the end, so the list shows the full loop.
     */
    readonly cycle: readonly string[],
  ) {
    super(`Required dependencies form a cycle: ${cycle.join(' -> ')}.`);
  }
}

/**
 * @summary Tells whether a dependency is required.
 *
 * @example
 * Example 1: The default is required
 * ```ts
 * isRequired({ target: 'storage' }); // true
 * ```
 *
 * @example
 * Example 2: An optional dependency
 * ```ts
 * isRequired({ target: 'consent', kind: 'optional' }); // false
 * ```
 *
 * @param {Dependency} dependency The dependency.
 * @returns {boolean} `true` unless `kind` is `optional`.
 *
 * @public
 */
export function isRequired(dependency: Dependency): boolean {
  return (dependency.kind ?? 'required') === 'required';
}

/**
 * @summary The dependency graph of every registered unit.
 *
 * @description
 * Built from {@linkcode DependencyNode}s, it answers three questions: whether
 * required dependencies form a cycle (`validate`), which required targets are
 * not registered at all (`missing`), and in which order units should boot
 * (`order`): dependencies first, then registration order. Duplicate ids are
 * rejected when it is built.
 *
 * The kernel builds one from every subsystem and feature when it is
 * constructed. Use it directly to check a configuration in tooling or tests.
 *
 * @example
 * Example 1: Ordering a boot
 * ```ts
 * const graph = new DependencyGraph([
 *   { id: 'storage', requires: [] },
 *   { id: 'auth', requires: [{ target: 'storage' }] },
 * ]);
 * graph.validate();
 * graph.order(); // ['storage', 'auth']
 * ```
 *
 * @example
 * Example 2: Finding dependencies that are not installed
 * ```ts
 * const graph = new DependencyGraph([{ id: 'analytics', requires: [{ target: 'consent' }] }]);
 * graph.missing('analytics'); // ['consent']: analytics will never start
 * ```
 *
 * @public
 */
export class DependencyGraph {
  readonly #nodes = new Map<string, DependencyNode>();

  /**
   * @summary Builds the graph from all units.
   * @param {Iterable<DependencyNode>} nodes Every unit, in registration order.
   * @throws {Error} When two nodes share an id.
   */
  constructor(nodes: Iterable<DependencyNode>) {
    for (const node of nodes) {
      if (this.#nodes.has(node.id)) throw new Error(`Unit "${node.id}" is registered twice.`);
      this.#nodes.set(node.id, node);
    }
  }

  /**
   * @summary Tells whether a unit with this id is registered.
   * @param {string} id The unit's full id.
   * @returns {boolean} `true` when registered.
   */
  has(id: string): boolean {
    return this.#nodes.has(id);
  }

  /**
   * @summary Lists the required targets of `id` that are not registered.
   * @description A unit with missing required targets can never start.
   * @param {string} id The unit's full id.
   * @returns {string[]} The missing targets. Empty for an unknown id.
   */
  missing(id: string): string[] {
    return (this.#nodes.get(id)?.requires ?? [])
      .filter((d) => isRequired(d) && !this.#nodes.has(d.target))
      .map((d) => d.target);
  }

  /**
   * @summary Rejects cycles of required dependencies.
   * @description Depth-first search over required edges between registered units.
   * @throws {DependencyCycleError} With the ids along the first cycle found.
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
        // Reaching a node still on the stack closes a cycle.
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
   * @summary Returns a deterministic boot order: dependencies first, then registration order.
   * @description Honours optional dependencies too, unless they would form a
   * cycle, in which case only required dependencies decide the order.
   * @returns {string[]} Every registered id.
   * @throws {DependencyCycleError} When required dependencies form a cycle.
   */
  order(): string[] {
    this.validate();
    return this.#topologicalOrder(true) ?? this.#topologicalOrder(false)!;
  }

  /**
   * @summary Kahn's algorithm, always picking the earliest-registered node whose dependencies are placed.
   * @param {boolean} withOptional Whether optional edges count.
   * @returns {string[] | null} The order, or `null` when the edges form a cycle.
   * @internal
   */
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
 * @summary Buffers writes for a dependency that is not ready yet (ARCHITECTURE §7.2).
 *
 * @description
 * Before `bind`, `write` keeps items in a buffer of `capacity` items; on
 * overflow the oldest item is dropped, counted in `dropped`, and reported to
 * `onDrop`. `bind` drains the buffer into the sink in order, then passes
 * writes straight through. `unbind` goes back to buffering, for example when
 * the dependency leaves `READY`.
 *
 * Centralized subsystems start before the subsystems they write to. This one
 * mechanism covers the Logger's ring buffer, the Queue's dead letters and
 * Global State restoration.
 *
 * @example
 * Example 1: Logging before Storage is ready
 * ```ts
 * const logs = new LateBinding<string>({ capacity: 500 });
 * logs.write('boot'); // buffered: storage is not ready
 * await logs.bind((line) => storage.append(line)); // drains 'boot', then writes go straight through
 * ```
 *
 * @example
 * Example 2: Recording overflow as a fingerprint
 * ```ts
 * const deadLetters = new LateBinding<PacketEnvelope>({
 *   capacity: 100,
 *   onDrop: (_dropped, total) => logger.warn(`dead letters dropped: ${total}`),
 * });
 * ```
 *
 * @template T The item type.
 * @public
 */
export class LateBinding<T> {
  readonly #buffer: T[] = [];
  #sink: ((item: T) => void | Promise<void>) | null = null;
  #draining = false;
  #dropped = 0;

  /**
   * @summary Creates an unbound buffer.
   * @param {object} options `capacity` (at least 1) and an optional `onDrop` callback.
   * @throws {RangeError} When `capacity` is below 1.
   */
  constructor(
    private readonly options: {
      readonly capacity: number;
      /** Called for each dropped item, with the running total. */
      readonly onDrop?: (item: T, totalDropped: number) => void;
    },
  ) {
    if (options.capacity < 1) throw new RangeError('LateBinding capacity must be at least 1.');
  }

  /**
   * @summary How many items wait in the buffer.
   * @returns {number} The count.
   */
  get buffered(): number {
    return this.#buffer.length;
  }

  /**
   * @summary How many items were dropped on overflow.
   * @returns {number} The running total.
   */
  get dropped(): number {
    return this.#dropped;
  }

  /**
   * @summary Tells whether writes pass straight to the sink.
   * @returns {boolean} `true` when bound and not draining.
   */
  get bound(): boolean {
    return this.#sink !== null && !this.#draining;
  }

  /**
   * @summary Writes an item: to the sink when bound, otherwise to the buffer.
   * @param {T} item The item.
   * @returns {void | Promise<void>} The sink's result when bound.
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
   * @description Writes that arrive while draining are queued behind the
   * buffered ones. If the sink fails, the failed item stays at the front of
   * the buffer, the binding is undone, and the error is rethrown.
   * @param {(item: T) => void | Promise<void>} sink Receives each item.
   * @returns {Promise<void>} Resolves once the buffer is drained.
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
