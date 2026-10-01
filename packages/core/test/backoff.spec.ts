import { describe, expect, it } from 'vitest';

import { computeBackoff } from '../src';

describe('computeBackoff', () => {
  it('grows exponentially by default', () => {
    expect([1, 2, 3].map((attempts) => computeBackoff({ base: 100, attempts }))).toEqual([
      200, 400, 800,
    ]);
  });

  it('supports multiplicative and linear growth', () => {
    expect(
      computeBackoff({
        base: 100,
        attempts: 2,
        strategy: 'multiplicative-exponential',
        multiplier: 3,
      }),
    ).toBe(900);
    expect(computeBackoff({ base: 100, attempts: 3, strategy: 'linear', multiplier: 500 })).toBe(
      1_600,
    );
  });

  it('draws jitter from the random source', () => {
    const half = () => 0.5;
    expect(
      computeBackoff({ base: 100, attempts: 3, strategy: 'exponential-jitter', random: half }),
    ).toBe(400);
    expect(
      computeBackoff({
        base: 100,
        attempts: 2,
        strategy: 'decorrelated-jitter',
        previousWait: 200,
        random: half,
      }),
    ).toBe(350); // 100 + 0.5 * (600 - 100)
  });

  it('keeps real jitter within its bounds', () => {
    for (let i = 0; i < 50; i++) {
      const wait = computeBackoff({ base: 100, attempts: 3, strategy: 'exponential-jitter' });
      expect(wait).toBeGreaterThanOrEqual(0);
      expect(wait).toBeLessThan(800);
    }
  });

  it('caps every strategy', () => {
    expect(computeBackoff({ base: 100, attempts: 30 })).toBe(30_000);
    expect(computeBackoff({ base: 1_000, attempts: 30 })).toBe(100_000);
    expect(computeBackoff({ base: 100, attempts: 30, maxCapMs: 5_000 })).toBe(5_000);
  });
});
