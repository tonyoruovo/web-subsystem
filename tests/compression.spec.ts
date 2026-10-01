import { describe, expect, it } from 'vitest';

import { compress, decompress } from '../src';

describe('compression', () => {
  it('round-trips a string through gzip', async () => {
    const input = 'hello world, hello world, hello world';
    expect(await decompress(await compress(input))).toBe(input);
  });

  it('compresses repetitive input smaller than the plain', async () => {
    const input = 'The quick brown fox. '.repeat(200);
    const packed = await compress(input);

    expect(packed.length).toBeLessThan(input.length);
    expect(await decompress(packed)).toBe(input);
  });
});
