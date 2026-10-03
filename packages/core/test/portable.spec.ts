import { describe, expect, it } from 'vitest';

import {
  PortableFunctionError,
  canEvaluate,
  fromPortable,
  isPortableFunction,
  toPortable,
  type PortableFunction,
} from '../src';

/** Rebuilds as another realm would: drops the registry id so the source is evaluated. */
const elsewhere = <T>(value: unknown): T =>
  fromPortable<T>(JSON.parse(JSON.stringify(value, (k, v) => (k === 'id' ? 'other-realm' : v))));

describe('portable functions', () => {
  it('copies values with functions into cloneable data', () => {
    const definition = {
      module: 'notes',
      migrations: [{ from: 1, run: (v: { title: string }) => ({ ...v, tags: [] as string[] }) }],
      when: new Date(0),
    };
    const portable = toPortable(definition) as {
      migrations: [{ run: PortableFunction }];
      when: Date;
    };
    expect(() => structuredClone(portable)).not.toThrow();
    expect(isPortableFunction(portable.migrations[0].run)).toBe(true);
    expect(portable.when).toBeInstanceOf(Date);
    expect(isPortableFunction({ id: 1 })).toBe(false);
  });

  it('gives back the original function in the same realm, closure included', () => {
    const factor = 3;
    const triple = (n: number) => n * factor;
    expect(fromPortable(toPortable(triple))).toBe(triple);
    expect(toPortable(triple)).toEqual(toPortable(triple)); // one id per function
  });

  it('rebuilds arrow functions, function expressions and method shorthands in another realm', () => {
    const shapes = {
      arrow: (a: number, b: number) => a - b,
      single: (x: number) => x + 1,
      asyncArrow: async (x: number) => x * 2,
      expression: function named(x: number) {
        return x * 10;
      },
      method(x: number) {
        return x - 1;
      },
      async asyncMethod(x: number) {
        return x + 100;
      },
      *generator() {
        yield 1;
        yield 2;
      },
    };
    const rebuilt = elsewhere<typeof shapes>(toPortable(shapes));
    expect(rebuilt.arrow(5, 3)).toBe(2);
    expect(rebuilt.single(1)).toBe(2);
    expect(rebuilt.expression(2)).toBe(20);
    expect(rebuilt.method(2)).toBe(1);
    expect([...rebuilt.generator()]).toEqual([1, 2]);
    expect(rebuilt.arrow).not.toBe(shapes.arrow);
    return Promise.all([
      expect(rebuilt.asyncArrow(4)).resolves.toBe(8),
      expect(rebuilt.asyncMethod(1)).resolves.toBe(101),
    ]);
  });

  it('refuses native and bound functions and classes, and reports closures that do not survive', () => {
    expect(() => toPortable(Math.max)).toThrow(PortableFunctionError);
    expect(() => toPortable((() => 1).bind(null))).toThrow(PortableFunctionError);
    expect(() => toPortable(class Foo {})).toThrow('is a class');
    const factor = 3;
    const triple = elsewhere<(n: number) => number>(toPortable((n: number) => n * factor));
    expect(() => triple(2)).toThrow(ReferenceError);
    expect(() =>
      fromPortable({ __portable: 'function', id: 'x', name: 'bad', source: 'not code(' }),
    ).toThrow(PortableFunctionError);
    expect(canEvaluate()).toBe(true);
  });
});
