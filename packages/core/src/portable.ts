/**
 * @fileoverview
 * @summary Portable functions: move self-contained functions across worker and storage boundaries.
 * @description
 * Implements docs/ARCHITECTURE.md §8.8. Structured clone, `postMessage` and
 * IndexedDB refuse functions. A processor in a worker still often needs the
 * code of its caller: a migration step, a serializer, a query predicate, an
 * eviction comparator. This module turns functions into plain data and back.
 *
 * ```text
 *   toPortable(value)    deep copy: each function --> { __portable: 'function', id, source }
 *                        (the realm keeps id --> function in a registry)
 *        |  postMessage / IndexedDB / JSON
 *        v
 *   fromPortable(value)  same realm:  id --> the original function (no eval)
 *                        other realm: source --> new Function(...) (needs eval)
 *   ```
 *
 * A portable function must be **self-contained**: it uses only its
 * parameters and the globals of the runtime. A closure variable, `this`, an
 * import or a native or bound function does not survive the trip. In another
 * realm, the rebuilt function throws a `ReferenceError` when it reaches such a
 * name.
 *
 * Rebuilding needs `eval`. Under a Content Security Policy without
 * `'unsafe-eval'`, {@linkcode canEvaluate} is `false` and
 * {@linkcode fromPortable} throws in another realm. A processor checks
 * `canEvaluate()` in `setup` and refuses the host, so the runner fails over to
 * the main thread, where the registry gives back the original functions.
 *
 * @example
 * Sending a migration to a worker
 * ```ts
 * const definition = toPortable({ version: 2, migrations: [{ from: 1, run: (v) => ({ ...v, tags: [] }) }] });
 * worker.postMessage(definition);
 * ```
 *
 * @example
 * Rebuilding it in the worker
 * ```ts
 * onmessage = (event) => {
 *   const { migrations } = fromPortable(event.data) as Definition;
 *   migrations[0].run({ title: 'a' }); // { title: 'a', tags: [] }
 * };
 * ```
 *
 * @throws {PortableFunctionError} From {@linkcode toPortable} for a native or bound function, and from {@linkcode fromPortable} when the source cannot be evaluated.
 * @author MathAid
 */

/**
 * @summary A function as plain data.
 *
 * @example
 * Example 1: An arrow function
 * ```ts
 * // { __portable: 'function', id: 'fn-1', name: 'byDate', source: '(a, b) => a.time - b.time' }
 * ```
 *
 * @example
 * Example 2: Checking for one
 * ```ts
 * isPortableFunction(value); // true for the shape above
 * ```
 *
 * @public
 */
export interface PortableFunction {
  /**
   * @summary The tag of a portable function. Its value is always `'function'`.
   */
  readonly __portable: 'function';
  /**
   * @summary The id of the function in the registry of the realm that made it.
   */
  readonly id: string;
  /**
   * @summary The name of the function, for error messages.
   */
  readonly name: string;
  /**
   * @summary The source text of the function, as an expression.
   */
  readonly source: string;
}

/**
 * @summary Thrown when a function cannot be made portable, or rebuilt.
 *
 * @example
 * Example 1: A native function
 * ```ts
 * toPortable(Math.max); // throws PortableFunctionError
 * ```
 *
 * @example
 * Example 2: A strict CSP in the worker
 * ```ts
 * fromPortable(data); // throws PortableFunctionError: eval is not allowed here
 * ```
 *
 * @public
 */
export class PortableFunctionError extends Error {
  /**
   * @summary The name of the error class: `'PortableFunctionError'`.
   */
  override readonly name = 'PortableFunctionError';
}

/** @summary Any function value. @internal */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFunction = (...args: any[]) => unknown;

/** @summary The functions of this realm, by id. @internal */
const registry = new Map<string, AnyFunction>();
/** @summary The id of each function of this realm that was made portable. @internal */
const ids = new WeakMap<AnyFunction, string>();
/** @summary A unique prefix for the ids of this realm. @internal */
const realm = Math.random().toString(36).slice(2, 10);
let next = 0;

/**
 * @summary Tells if this realm can rebuild a function from its source.
 *
 * @description `false` under a Content Security Policy without
 * `'unsafe-eval'`. The result does not change, so the check runs one time.
 *
 * @example
 * Example 1: Refusing a host in setup
 * ```ts
 * setup: () => {
 *   if (!canEvaluate()) throw new Error('This worker cannot run portable functions.');
 * },
 * ```
 *
 * @example
 * Example 2: Choosing a code path
 * ```ts
 * const filter = canEvaluate() ? fromPortable(portable) : null;
 * ```
 *
 * @returns {boolean} `true` when `new Function` works here.
 *
 * @public
 */
export function canEvaluate(): boolean {
  evaluates ??= (() => {
    try {
      return new Function('return 1')() === 1;
    } catch {
      return false;
    }
  })();
  return evaluates;
}
let evaluates: boolean | undefined;

/**
 * @summary Tells if a value is a {@linkcode PortableFunction}.
 *
 * @example
 * Example 1: A portable function
 * ```ts
 * isPortableFunction(toPortable(() => 1)); // true
 * ```
 *
 * @example
 * Example 2: Plain data
 * ```ts
 * isPortableFunction({ id: 1 }); // false
 * ```
 *
 * @param {unknown} value Any value.
 * @returns {boolean} `true` for a portable function.
 *
 * @public
 */
export function isPortableFunction(value: unknown): value is PortableFunction {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __portable?: unknown }).__portable === 'function' &&
    typeof (value as { source?: unknown }).source === 'string'
  );
}

/** @summary The source of a function as an expression that evaluates to it. @internal */
function expression(fn: AnyFunction): string {
  const source = Function.prototype.toString.call(fn).trim();
  if (/\{\s*\[native code\]\s*\}$/.test(source)) {
    throw new PortableFunctionError(
      `"${fn.name || 'anonymous'}" is a native or bound function and cannot be made portable.`,
    );
  }
  if (/^class\b/.test(source)) {
    throw new PortableFunctionError(
      `"${fn.name}" is a class. Only functions can be made portable.`,
    );
  }
  // Function expressions and arrow functions are already expressions.
  if (/^(async\s+)?function\b/.test(source)) return source;
  if (/^(async\s*)?\(/.test(source) || /^(async\s+)?[\w$]+\s*=>/.test(source)) return source;
  // A method shorthand ("name(a) {}", "async name(a) {}", "*gen() {}") becomes a function expression.
  const method = /^(async\s+)?(\*\s*)?[\w$]+\s*\(/.exec(source);
  if (method) {
    const [, isAsync = '', star = ''] = method;
    const rest = source.slice(isAsync.length + star.length);
    return `${isAsync}function${star ? '*' : ''} ${rest}`;
  }
  throw new PortableFunctionError(
    `The source of "${fn.name || 'anonymous'}" is not a function expression.`,
  );
}

/** @summary Makes one function portable, registering it in this realm. @internal */
function portableFunction(fn: AnyFunction): PortableFunction {
  let id = ids.get(fn);
  if (!id) {
    id = `${realm}-${++next}`;
    ids.set(fn, id);
    registry.set(id, fn);
  }
  return { __portable: 'function', id, name: fn.name, source: expression(fn) };
}

/**
 * @summary Copies a value and replaces each function in it with a {@linkcode PortableFunction}.
 *
 * @description
 * Walks plain objects and arrays at any depth. Other values (dates, maps,
 * typed arrays, class instances) stay as they are, so the result is as
 * cloneable as the input without its functions. The functions stay in a
 * registry of this realm, so {@linkcode fromPortable} in the same realm gives
 * them back without `eval`.
 *
 * @example
 * Example 1: A storage collection definition
 * ```ts
 * const portable = toPortable({ module: 'notes', serialize: (v) => JSON.stringify(v) });
 * structuredClone(portable); // works
 * ```
 *
 * @example
 * Example 2: A query predicate
 * ```ts
 * coordinator.call({ op: 'query', where: toPortable((note) => note.pinned) });
 * ```
 *
 * @template T The type of the value.
 * @param {T} value The value.
 * @returns {unknown} The copy, without functions.
 * @throws {PortableFunctionError} For a native function, a bound function or a class.
 *
 * @public
 */
export function toPortable<T>(value: T): unknown {
  if (typeof value === 'function') return portableFunction(value as AnyFunction);
  if (Array.isArray(value)) return value.map((item) => toPortable(item));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toPortable(v)]));
  }
  return value;
}

/**
 * @summary Copies a value and rebuilds each {@linkcode PortableFunction} in it.
 *
 * @description
 * In the realm that made a function, the registry gives back the original
 * function, with its closure. In another realm, the function is rebuilt from
 * its source with `new Function`, so it must be self-contained.
 *
 * @example
 * Example 1: In a worker
 * ```ts
 * const { serialize } = fromPortable(message.definition) as { serialize: (v: unknown) => string };
 * ```
 *
 * @example
 * Example 2: In the same realm, the original comes back
 * ```ts
 * const original = (n: number) => n * 2;
 * fromPortable(toPortable(original)) === original; // true
 * ```
 *
 * @template T The expected type of the result.
 * @param {unknown} value A value from {@linkcode toPortable}.
 * @returns {T} The copy, with functions.
 * @throws {PortableFunctionError} When a function must be rebuilt and this realm cannot evaluate code, or the source is not valid.
 *
 * @public
 */
export function fromPortable<T = unknown>(value: unknown): T {
  if (isPortableFunction(value)) {
    const original = registry.get(value.id);
    if (original) return original as T;
    if (!canEvaluate()) {
      throw new PortableFunctionError(
        `Cannot rebuild "${value.name || 'anonymous'}": this realm does not allow eval (Content Security Policy).`,
      );
    }
    try {
      return new Function(`"use strict"; return (${value.source});`)() as T;
    } catch (error) {
      throw new PortableFunctionError(
        `Cannot rebuild "${value.name || 'anonymous'}": ${(error as Error).message}`,
      );
    }
  }
  if (Array.isArray(value)) return value.map((item) => fromPortable(item)) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fromPortable(v)])) as T;
  }
  return value as T;
}
