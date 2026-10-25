import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocate } from '../src/index.ts';

describe('allocate', () => {
  it('never loses the odd penny', () => {
    expect(allocate(1000, [1, 1, 1])).toEqual([334, 333, 333]);
    expect(allocate(100, [1, 1, 1, 1, 1, 1])).toEqual([17, 17, 17, 17, 16, 16]);
    expect(allocate(1, [1, 1])).toEqual([1, 0]);
  });

  it('gives the leftover to the largest remainders, not simply the first people', () => {
    // Exact shares are 3.33, 6.67: the second has the larger remainder and gets the extra unit.
    expect(allocate(10, [1, 2])).toEqual([3, 7]);
  });

  it('splits by weight, and a zero weight gets nothing', () => {
    expect(allocate(900, [2, 1])).toEqual([600, 300]);
    expect(allocate(500, [0, 1, 0])).toEqual([0, 500, 0]);
  });

  it('mirrors a negative total, and never returns -0', () => {
    expect(allocate(-1000, [1, 1, 1])).toEqual([-334, -333, -333]);
    expect(Object.is(allocate(-1, [1, 1])[1], 0)).toBe(true);
  });

  it('stays exact where total × weight passes 2^53', () => {
    const total = Number.MAX_SAFE_INTEGER;
    const parts = allocate(total, [1_000_000, 3_000_000]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
  });

  it('refuses weights that make no sense', () => {
    expect(() => allocate(100, [])).toThrow(expect.objectContaining({ code: 'NO_PARTICIPANTS' }));
    expect(() => allocate(100, [0, 0])).toThrow(expect.objectContaining({ code: 'BAD_WEIGHT' }));
    expect(() => allocate(100, [1, -1])).toThrow(expect.objectContaining({ code: 'BAD_WEIGHT' }));
    expect(() => allocate(100, [1.5])).toThrow(expect.objectContaining({ code: 'BAD_WEIGHT' }));
    expect(() => allocate(10.5, [1])).toThrow(expect.objectContaining({ code: 'NOT_AN_INTEGER' }));
  });

  it('always adds up to the total, with every part within one unit of its exact share', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1e12, max: 1e12 }),
        fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 30 }).filter((w) => w.some(Boolean)),
        (total, weights) => {
          const parts = allocate(total, weights);
          expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
          const weightSum = weights.reduce((a, b) => a + b, 0);
          parts.forEach((part, index) => {
            const exact = (total * (weights[index] ?? 0)) / weightSum;
            expect(Math.abs(part - exact)).toBeLessThan(1 + 1e-6);
          });
        },
      ),
    );
  });
});
