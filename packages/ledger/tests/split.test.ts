import { describe, expect, it } from 'vitest';
import { splitAmount } from '../src/index.ts';

describe('splitAmount', () => {
  it('splits equally, and the order the members arrive in never changes the answer', () => {
    const expected = [
      { member: 'alex', amount: 334 },
      { member: 'priya', amount: 333 },
      { member: 'sam', amount: 333 },
    ];
    expect(splitAmount(1000, { kind: 'equal', members: ['alex', 'priya', 'sam'] })).toEqual(expected);
    expect(splitAmount(1000, { kind: 'equal', members: ['sam', 'alex', 'priya'] })).toEqual(expected);
  });

  it('takes exact amounts as given, when they add up', () => {
    const spec = {
      kind: 'exact',
      amounts: [
        { member: 'sam', amount: 700 },
        { member: 'alex', amount: 300 },
      ],
    } as const;
    expect(splitAmount(1000, spec)).toEqual([
      { member: 'alex', amount: 300 },
      { member: 'sam', amount: 700 },
    ]);
    expect(() => splitAmount(1001, spec)).toThrow(expect.objectContaining({ code: 'SPLIT_MISMATCH' }));
  });

  it('splits by percentage in basis points, which must make 100%', () => {
    const parts = [
      { member: 'alex', basisPoints: 3333 },
      { member: 'priya', basisPoints: 3333 },
      { member: 'sam', basisPoints: 3334 },
    ];
    const shares = splitAmount(1000, { kind: 'percent', parts });
    expect(shares.reduce((sum, share) => sum + share.amount, 0)).toBe(1000);
    expect(shares.map((share) => share.amount)).toEqual([333, 333, 334]);
    expect(() => splitAmount(1000, { kind: 'percent', parts: parts.slice(1) })).toThrow(
      expect.objectContaining({ code: 'SPLIT_MISMATCH' }),
    );
  });

  it('splits by shares, as in "two drinks and one drink"', () => {
    expect(
      splitAmount(900, {
        kind: 'shares',
        parts: [
          { member: 'alex', weight: 2 },
          { member: 'sam', weight: 1 },
        ],
      }),
    ).toEqual([
      { member: 'alex', amount: 600 },
      { member: 'sam', amount: 300 },
    ]);
  });

  it('refuses an empty split or anyone listed twice', () => {
    expect(() => splitAmount(100, { kind: 'equal', members: [] })).toThrow(
      expect.objectContaining({ code: 'NO_PARTICIPANTS' }),
    );
    expect(() => splitAmount(100, { kind: 'equal', members: ['sam', 'sam'] })).toThrow(
      expect.objectContaining({ code: 'DUPLICATE_MEMBER' }),
    );
    expect(() => splitAmount(100, { kind: 'percent', parts: [] })).toThrow(
      expect.objectContaining({ code: 'NO_PARTICIPANTS' }),
    );
  });
});
