/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ZodType } from 'zod';

export type JSType =
  'boolean' | 'number' | 'string' | 'symbol' | 'bigint' | 'object' | 'function' | 'undefined';

export type JSTuple<T, U> = [T, U];

/**
 * Safely extracts the element type from a given array or tuple type.
 *
 * @typeParam TArray - The array type to extract elements from. Falls back to `unknown` if a non-array is passed.
 * @typeParam TExpected - An optional constraint defining what the items should extend.
 *
 * @public
 */
export type ArrayType<TArray, TExpected = unknown> = TArray extends TExpected[]
  ? TArray[number]
  : unknown;

/**
 * Extracts all nullable properties in `T` into a separate type
 *
 * @template T the type of object from which the nullable properties will be extracted
 */
export type NullableEntries<T extends object> = NullablePart<T>;
/** The same as {@linkcode NullableEntries} but for `undefined` instead of `null` */
export type UndefinedEntries<T extends object> = UndefinedPart<T>;
/**
 * Extracts all nullable or undefined properties in `T` into a separate type
 *
 * @template T the type of object from which the undefined properties will be extracted
 */
export type NilEntries<T extends object> = NullishPart<T>;

/**
 * @summary Creates a type with only the nullable properties (key + value pair preserved).
 *
 * Maps an object type `T` to a new type containing **only** the properties where `null` is assignable to the value type
 * (i.e. the property can be `null` - either `null` itself or part of a union that includes `null`).
 * Returns `never` if `T` is not an object type.
 *
 * This extract a subset of an object type containing only fields that are allowed to be `null`, keeping both keys and their original value types.
 *
 * ### Capabilities
 *   - Preserves the original value types (including unions)
 *   - Works with interfaces, types, classes, records
 *   - Returns an empty object (`{}`) when no properties match (instead of `never`)
 *   - Returns `never` only when input is not an object-like type
 *
 * ### Application
 *   - API response filtering / transformation
 *   - Safe null-handling utilities
 *   - Creating partial types focused on nullable fields
 * @example
 * ```ts
 * interface User {
 *   id: number;
 *   name: string | null;
 *   email: null;
 *   age?: number;           // number | undefined - not nullable
 *   avatarUrl: string | null | undefined;
 * }
 *
 * type NullablePart = NullablePart<User>;
 * //   ↑↑↑ type NullablePart = {
 * //         name: string | null;
 * //         email: null;
 * //         avatarUrl: string | null | undefined;
 * //       }
 *
 * // Non-object input
 * type NotObj = NullablePart<string>;   // never
 * ```
 * @template T The object type to extract nullable properties from
 */
export type NullablePart<T> = T extends object
  ? { [K in keyof T as null extends T[K] ? K : never]: T[K] }
  : never;
/**
 * The same as {@linkcode NullablePart} but for `undefined` instead of `null`,
 * i.e it is to `undefined` what `NullablePart` is to `null`
 *
 * @template T The object type to extract undefined properties from
 */
export type UndefinedPart<T> = T extends object
  ? { [K in keyof T as undefined extends T[K] ? K : never]: T[K] }
  : never;

/**
 * Maps an object type `T` to a new type containing **only** the properties where `undefined` is assignable to the value type
 * (i.e. optional properties or properties explicitly typed with `undefined` in the union).
 * Returns `never` if `T` is not an object type.
 *
 * @summary Creates a type with only the undefinable/optional-like properties (key + value pair preserved).
 * @purpose Extract a subset containing only fields that are allowed to be `undefined`.
 * @example
 * ```ts
 * interface Config {
 *   theme: string;
 *   fontSize?: number;           // number | undefined
 *   debug: boolean | undefined;
 *   logger: undefined;
 * }
 *
 * type UndefinablePart = UndefinablePart<Config>;
 * //   ↑↑↑ type UndefinablePart = {
 * //         fontSize?: number;
 * //         debug: boolean | undefined;
 * //         logger: undefined;
 * //       }
 * ```
 * @typeparam T The object type to extract undefinable properties from
 */
export type UndefinablePart<T> = UndefinedPart<T>;

/**
 * Combines both nullable and undefinable properties into a single mapped type.
 * Contains **all properties** that accept **either** `null` **or** `undefined` (or both).
 *
 * @summary Union (in terms of properties) of nullable and undefinable fields, keeping original value types.
 * @example
 * ```ts
 * interface Data {
 *   id: number;
 *   value: number | null | undefined;
 *   status?: string;               // string | undefined
 *   error: Error | null;
 *   fallback: undefined;
 * }
 *
 * type NullishPart = NullishPart<Data>;
 * //   ↑↑↑ type NullishPart = {
 * //         value: number | null | undefined;
 * //         status?: string;
 * //         error: Error | null;
 * //         fallback: undefined;
 * //       }
 * ```
 * @typeparam T The object type to extract nullish (null or undefined) properties from
 */
export type NullishPart<T> = T extends object ? NullablePart<T> & UndefinablePart<T> : never;
/**
 * Determines if a type can be null or undefined.
 *
 * `false` if T extends null | undefined | never, true otherwise
 *
 * @template T - The type to check for nullability
 *
 * @example
 * type A = IsNullable<string>;        // true
 * type B = IsNullable<string | null>; // true
 * type C = IsNullable<never>;         // false
 *
 * @internal Used internally for type-safe filter generation
 */
export type IsNullable<T> = null extends T ? true : false;
/** Alias for {@linkcode IsNullable} */
export type IsNull<T> = IsNullable<T>;
/**
 * The same as {@linkcode IsNullable} but for undefined` instead of `null`
 *
 * @template T the type to check for `undefined`
 */
export type IsUndefined<T> = undefined extends T ? true : false;
/**
 * Determines if T is type undefined or nullable (disjunction)
 *
 * @template T the type to check
 */
export type IsNil<T> = true extends IsNull<T> | IsUndefined<T> ? true : false;
/**
 * Determines if T is type undefined and null (conjunction)
 *
 * @template T the type to check
 */
export type EveryNil<T> = [IsNull<T>, IsUndefined<T>] extends [true, true] ? true : false;
/**
 * @summary Checks if a specific key exists within a given type.
 *
 * Determines if `Key` is one of the valid properties of `T`. This works for
 * Interfaces, Type Aliases, and Records.
 *
 * - Validates against both required and optional properties.
 * - Supports string, number, and symbol keys.
 * - Returns `true` if the key exists, otherwise `false`.
 *
 * Useful for conditional type logic where behavior depends on the presence
 * of specific fields (e.g., API response mapping).
 *
 * @example
 * type User = { id: number; name: string; age?: number };
 * type HasName = HasKey<User, "name">; // true
 * type HasEmail = HasKey<User, "email">; // false
 *
 * @template T - The type to inspect.
 * @template Prop - The property name to look for.
 */
export type HasProp<T, Prop extends string | number | symbol> = Prop extends keyof T ? true : false;

export type IsBoolean<T> = boolean extends T ? true : false;
export type IsSymbol<T> = symbol extends T ? true : false;
export type IsNumber<T> = number extends T ? true : false;
export type IsBigInt<T> = bigint extends T ? true : false;
export type IsString<T> = string extends T ? true : false;
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export type IsFunction<T> = Function extends T ? true : false;
/**
 * Core utility to check if a type structurally behaves as a generic array.
 *
 * @typeParam T - The subject type under validation.
 * @public
 */

export type IsArray<T> = Array<any> extends T ? true : false;
export type IsObject<T> = object extends T ? true : false;
/**
 * Validates whether a specific type is both an array and closely matches a targeted element type structure.
 *
 * @typeParam TArray - The subject array type under evaluation.
 * @typeParam TTarget - The structural target type to match against the extracted array element.
 *
 * @remarks
 * This conditional evaluation wraps checks into a single-element tuple `[ ... ]`
 * to bypass default TypeScript distributive conditional behavior on union types.
 *
 * @see {@link IsArray} for the structural array validator dependency.
 * @public
 */
export type IsArrayType<TArray, TTarget> = [IsArray<TTarget>, ArrayType<TArray, TTarget>] extends [
  true,
  TTarget,
]
  ? true
  : false;

/**
 * Checks if a boolean type can be null or undefined.
 *
 * Determines whether a boolean field is optional (nullable) in the database schema.
 * Used to select between nullable and non-nullable filter types.
 *
 * `true` if T includes null or undefined, false for strict boolean
 *
 * @template T - A boolean type, potentially union with null/undefined
 *
 * @example
 * type A = IsNullableBoolean<boolean>;        // false
 * type B = IsNullableBoolean<boolean | null>; // true
 * type C = IsNullableBoolean<boolean | undefined>; // true
 *
 * @see {@linkcode BoolFilter} - Used when false
 * @see {@linkcode BoolNullableFilter} - Used when true
 */
export type IsNullableBoolean<T> = boolean extends T
  ? IsNullable<T> extends true
    ? true
    : false
  : false;

/**
 * Checks if an integer type can be null or undefined.
 *
 * Determines whether a numeric field is optional (nullable) in the database schema.
 * Used to select between nullable and non-nullable filter types.
 *
 * `true` if T includes null or undefined, false for strict number
 *
 * @template T - A number type, potentially union with null/undefined
 *
 * @example
 * type A = IsNullableInt<number>;        // false
 * type B = IsNullableInt<number | null>; // true
 * type C = IsNullableInt<number | undefined>; // true
 *
 * @see {@linkcode IntFilter} - Used when false
 * @see {@linkcode IntNullableFilter} - Used when true
 */
export type IsNullableInt<T> = number extends T
  ? IsNullable<T> extends true
    ? true
    : false
  : false;

/**
 * Checks if a string type can be null or undefined.
 *
 * Determines whether a string field (including enums and IDs) is optional (nullable) in the database schema.
 * Used to select between nullable and non-nullable filter types.
 *
 * `true` if T includes null or undefined, false for strict string
 *
 * @template T - A string type, potentially union with null/undefined
 *
 * @example
 * type A = IsNullableString<string>;        // false
 * type B = IsNullableString<string | null>; // true
 * type C = IsNullableString<string | undefined>; // true
 *
 * @see {@linkcode StringFilter} - Used when false
 * @see {@linkcode StringNullableFilter} - Used when true
 */
export type IsNullableString<T> = string extends T
  ? IsNullable<T> extends true
    ? true
    : false
  : false;

/**
 * Checks if a Date type can be null or undefined.
 *
 * Determines whether a DateTime field is optional (nullable) in the database schema.
 * Used to select between nullable and non-nullable filter types.
 *
 * `true` if T includes null or undefined, false for strict Date
 *
 * @template T - A Date type, potentially union with null/undefined
 *
 * @example
 * type A = IsNullableDate<Date>;        // false
 * type B = IsNullableDate<Date | null>; // true
 * type C = IsNullableDate<Date | undefined>; // true
 *
 * @see {@linkcode DateTimeFilter} - Used when false
 * @see {@linkcode DateTimeNullableFilter} - Used when true
 */
export type IsNullableDate<T> = Date extends T
  ? IsNullable<T> extends true
    ? true
    : false
  : false;

/**
 * @summary Checks if an object contains a specific value type.
 *
 * This utility evaluates whether the provided object `T` has at least one property
 * whose value type matches (or is a subtype of) the target `Type`.
 *
 * - Checks across all object keys dynamically.
 * - Supports union types (e.g., checks if any property is `string | null`).
 * - Returns `true` if a match is found, otherwise `false`.
 *
 * Useful for conditional logic in complex types, such as determining if a
 * form state contains any "File" types or "Error" objects.
 *
 * @example
 * type User = { id: number; name: string; avatar: null };
 * type HasNull = ObjHasType<User, null>; // true
 * type HasBoolean = ObjHasType<User, boolean>; // false
 *
 * @template T - The source object to inspect. Must extend Record<string, any>.
 * @template Target - The value type to search for within the object's properties.
 */
export type ContainsType<
  T extends Record<string | number | symbol, any>,
  Target,
> = Target extends T[keyof T] ? true : false;

/**
 * @summary Checks if an object contains a property with an exact type match.
 *
 * Iterates through all properties of object `T` and performs a strict equality
 * check against `Target`. Unlike `extends`, this ensures that unions must
 * match perfectly (e.g., `string | null` will not match `string`).
 *
 * - Distinguishes between similar types (e.g., `any` vs `unknown`).
 * - Handles union types strictly.
 * - Prevents subtype matching (e.g., `true` is not equal to `boolean`).
 *
 * Used in strict type-guarding or when searching for specific wrapper types
 * that shouldn't be confused with their primitives.
 *
 * @example
 * type Data = { id: number; flag: true; };
 * type MatchTrue = ObjHasExactType<Data, true>;    // true
 * type MatchBool = ObjHasExactType<Data, boolean>; // false (because 'true' !== 'boolean')
 *
 * @template T - The object to scan.
 * @template Target - The exact type to look for.
 */

export type ContainsExactType<T extends Record<string, any>, Target> = true extends {
  [K in keyof T]: [Target, T[K]] extends [T[K], Target] ? true : false;
}[keyof T]
  ? true
  : false;

/**
 * Make a specific property required from a type (perhaps where it was previously optional), while keeping other properties as they are
 *
 * This is useful when you want to ensure that a certain property is always present in an object, while allowing other properties to remain optional.
 */
export type EnsureKey<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>;

/**
 * Alias for `EnsureKey` to make a specific property required from a type.
 */
export type RequireKeys<T, K extends keyof T> = EnsureKey<T, K>;

export type OptionalKeys<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export type Validator<T extends object> = Record<keyof T, ZodType>;

/**
 * Creates a type where if any of the `ConditionProps` are present on an object,
 * then all of the `RequiredProps` must also be present.
 *
 * @template T The base object type.
 * @template ConditionProps The conditional properties. If any of these exist, `RequiredProps` must also exist.
 * @template RequiredProps The properties that are required when a `ConditionProps` is present.
 *
 * @example
 * interface Fruit {
 *   color?: string;
 *   size?: number;
 *   name?: string;
 *   weight?: number;
 * }
 *
 * type ConditionalFruit = RequireWithDependency<Fruit, 'color' | 'size', 'name' | 'weight'>;
 *
 * const a: ConditionalFruit = { name: 'apple', weight: 150 }; // OK
 * const b: ConditionalFruit = { color: 'red', name: 'apple', weight: 150 }; // OK
 * const c: ConditionalFruit = { color: 'red' }; // Error: `name` and `weight` are missing
 */
export type RequireWithDependency<
  T,
  ConditionProps extends keyof T,
  RequiredProps extends keyof T,
> =
  | (Omit<T, ConditionProps> & { [P in ConditionProps]?: never })
  | (T & Required<Pick<T, RequiredProps>>);

/**
 * @summary Defines a generic shape for executable callback functions.
 *
 * @description
 * A loose but typesafe function shape capturing parameter arrays and returns.
 * - **Generics**: `T` defaults to `never[]` to represent open-ended parameter layouts if left unconfigured. `R` defaults to `unknown` to maximize return versatility.
 *
 * Used to type-constrain execution utility hooks, ensuring that any mapped function wrapper mirrors input properties perfectly while allowing accurate `this` extraction.
 *
 * @template T - Array representing the explicit types of parameters the function accepts.
 * @template R - The resolved return value type of the function execution.
 */
export type FunctionLike<T extends unknown[] = never[], R = unknown> = (...args: T) => R;

/**
 * @summary Configuration options structure supporting standard DOM AbortSignals.
 */
export interface RateLimitOptions {
  /** An optional AbortSignal to trigger automatic framework cleanup and cancellation. */
  signal?: AbortSignal;
}

/**
 * @summary Extended interface adding administrative control methods to synchronous rate-limited functions.
 *
 * @description
 * A callable interface that mirrors the parameter signature of the wrapped function `T` while
 * exposing a `.cancel()` administrative hook. It is the return type of {@linkcode debounce} and
 * {@linkcode throttle}, and is the synchronous counterpart of {@linkcode CancellableAsync}.
 *
 * The interface has two members:
 * - **Call signature** `(...args: Parameters<T>): void` - forwards invocations to the internal
 *   scheduling logic with full argument and `this`-context preservation. The original return
 *   value of `T` is discarded because execution occurs asynchronously after the rate-limit
 *   window, after the call stack has already cleared.
 * - **`.cancel(): boolean`** - immediately clears any pending timer without invoking the target.
 *   Returns `true` if a scheduled execution was actively discarded, or `false` if nothing
 *   was pending (idempotent, safe to call unconditionally).
 *
 * After an associated `AbortSignal` has fired, all further invocations of the call signature
 * throw a `ReferenceError` synchronously. The `.cancel()` method remains callable but will
 * always return `false` once the signal has already cleared internal state via the abort handler.
 *
 * @example
 * // debounce - trailing-edge, returns Cancellable<T>
 * const save = debounce((data: FormData) => api.save(data), 400);
 *
 * save(formData);           // schedules execution
 * save(formData);           // resets timer; first call discarded
 * const cleared = save.cancel(); // → true: pending timer cleared
 * save.cancel();            // → false: nothing pending, safe no-op
 *
 * @example
 * // throttle - dual-edge, returns Cancellable<T>
 * const track = throttle((x: number, y: number) => render(x, y), 100);
 *
 * track(0, 0);   // fires immediately (leading edge)
 * track(1, 1);   // cached as trailing args; timer scheduled
 * track(2, 2);   // trailing args updated to (2, 2); no new timer
 * // ~100ms later: render(2, 2) fires (trailing edge)
 *
 * @example
 * // AbortSignal integration - invocation after abort throws
 * const controller = new AbortController();
 * const log = debounce((msg: string) => console.log(msg), 200, { signal: controller.signal });
 *
 * log('hello');
 * controller.abort();
 * log('world'); // throws ReferenceError: 'The input signal was already aborted prior'
 *
 * @template T - The wrapped function type. Constrains the call signature's parameter array and
 * `this` type to match the original function exactly.
 *
 * @see {@linkcode debounce} - produces a `Cancellable<T>` with trailing-edge semantics
 * @see {@linkcode throttle} - produces a `Cancellable<T>` with dual-edge semantics
 * @see {@linkcode CancellableAsync} - async variant for Promise-returning functions
 * @author MathAid
 */
export interface Cancellable<T extends FunctionLike<any>> {
  (...args: Parameters<T>): void;
  /**
   * Immediately clears any pending scheduled execution without invoking the target function.
   *
   * For `throttle`, also fully resets internal timing state so the next invocation fires
   * immediately on the leading edge, as if the throttle had just been created.
   *
   * @returns `true` if an active timer was discarded; `false` if nothing was pending.
   * Safe to call unconditionally - repeated calls after cancellation always return `false`.
   */
  cancel(): boolean;
}

/**
 * @summary Extended interface adding administrative control methods to async debounced functions.
 *
 * @description
 * A callable interface that mirrors the parameter signature of the wrapped async function `T`,
 * surfacing a `Promise<R>` per invocation and exposing a `.cancel()` administrative hook. It is
 * the return type of {@linkcode debounceAsync}, and is the async counterpart of {@linkcode Cancellable}.
 *
 * The interface has two members:
 * - **Call signature** `(...args: Parameters<T>): Promise<R>` - schedules the wrapped `fn` after
 *   the debounce delay and returns a `Promise<R>` that settles when `fn` completes. Each new
 *   invocation before the timer fires supersedes the previous one: the superseded Promise is
 *   rejected with `"A newer invocation canceled this task."`, ensuring callers are never silently
 *   abandoned with a permanently pending Promise.
 * - **`.cancel(): boolean`** - immediately clears any pending timer and rejects the current
 *   pending Promise (if any) with `"Task was explicitly canceled by the user."`. Returns `true`
 *   if there was active pending work (timer or in-flight `fn` execution), `false` otherwise.
 *   Safe to call unconditionally.
 *
 * **Promise settlement contract:**
 * - The **final** scheduled invocation resolves with `R` (or rejects if `fn` itself throws).
 * - **Superseded** intermediate invocations reject immediately when displaced by a newer call.
 * - Any pending invocation rejects immediately when `.cancel()` is called.
 * - Any pending invocation rejects immediately when the associated `AbortSignal` fires.
 * - After an `AbortSignal` has fired, further call-signature invocations return an already-rejected
 *   `Promise` rather than throwing synchronously (unlike the synchronous {@linkcode Cancellable}).
 *
 * @example
 * // Example 1: Awaiting the final debounced result
 * const search = debounceAsync(async (q: string) => fetchResults(q), 300);
 *
 * // Rapid calls - only the last one resolves; earlier ones reject
 * search('r').catch(() => {});   // superseded → rejects
 * search('re').catch(() => {});  // superseded → rejects
 * const data = await search('react'); // final → resolves with fetchResults('react')
 *
 * @example
 * // Example 2: Explicit cancellation
 * const upload = debounceAsync(async (file: File) => api.upload(file), 500);
 *
 * const p = upload(file);
 * vi.advanceTimersByTime(200);
 * const wasPending = upload.cancel(); // → true; p rejects with cancellation error
 * upload.cancel();                    // → false; nothing pending
 *
 * await p.catch(err => console.log(err.message));
 * // "Debounced: Task was explicitly canceled by the user."
 *
 * @example
 * // Example 3: AbortSignal integration
 * const controller = new AbortController();
 * const query = debounceAsync(async (val: string) => fetch(val), 400, {
 *   signal: controller.signal,
 * });
 *
 * const p = query('/api/data');
 * controller.abort(new Error('Component unmounted'));
 * await p.catch(err => console.log(err.message)); // 'Component unmounted'
 *
 * query('/api/retry'); // returns an already-rejected Promise (signal is aborted)
 *
 * @template T - The wrapped async function type. Constrains the call signature's parameter array
 * and `this` type to match the original function exactly.
 * @template R - The resolved value type of the Promise returned by `T`. Defaults to `any`.
 *
 * @throws {Error} The returned Promise rejects in three scenarios:
 * - Supersession: a newer call displaces this one before the timer fires.
 * - Cancellation: `.cancel()` is called while this invocation is pending.
 * - Abort: the associated `AbortSignal` fires while this invocation is pending.
 *
 * @see {@linkcode debounceAsync} - the sole producer of `CancellableAsync<T, R>`
 * @see {@linkcode Cancellable} - synchronous counterpart for `void`-returning rate-limited functions
 * @author MathAid
 */
export interface CancellableAsync<T extends FunctionLike<any, Promise<R>>, R = any> {
  (...args: Parameters<T>): Promise<R>;
  /**
   * Immediately clears any pending timer and rejects the currently pending `Promise` (if any).
   *
   * The rejection reason is `Error("Debounced: Task was explicitly canceled by the user.")`.
   * If `fn` is already executing (timer has fired but Promise has not yet settled), the
   * in-flight execution is allowed to complete naturally - only the pending-timer phase is
   * cancellable via this method.
   *
   * Also removes the internal `abort` event listener from the associated `AbortSignal` (if any),
   * making it safe to call during component teardown without risking duplicate rejections.
   *
   * @returns `true` if there was active pending work (timer or awaiting Promise); `false` otherwise.
   * Safe to call unconditionally - repeated calls always return `false` after the first.
   */
  cancel(): boolean;
}
