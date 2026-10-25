import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type Balances,
  balancesOf,
  type Expense,
  type Posting,
  reversePostings,
  settleUp,
  type Transfer,
  toPostings,
} from '../src/index.ts';

const dinner: Expense = {
  kind: 'expense',
  currency: 'GBP',
  total: 9000,
  paidBy: [{ member: 'alex', amount: 9000 }],
  split: { kind: 'equal', members: ['alex', 'priya', 'sam'] },
};

describe('toPostings', () => {
  it('turns an expense into what each person paid minus what they owe', () => {
    expect(toPostings(dinner)).toEqual([
      { member: 'alex', currency: 'GBP', amount: 6000 },
      { member: 'priya', currency: 'GBP', amount: -3000 },
      { member: 'sam', currency: 'GBP', amount: -3000 },
    ]);
  });

  it('handles two payers, and leaves out anyone who comes out even', () => {
    const postings = toPostings({
      ...dinner,
      paidBy: [
        { member: 'alex', amount: 6000 },
        { member: 'priya', amount: 3000 },
      ],
    });
    expect(postings).toEqual([
      { member: 'alex', currency: 'GBP', amount: 3000 },
      { member: 'sam', currency: 'GBP', amount: -3000 },
    ]);
  });

  it('records paying someone back as moving the debt, not as spending', () => {
    expect(toPostings({ kind: 'settlement', currency: 'GBP', from: 'sam', to: 'alex', amount: 3000 })).toEqual([
      { member: 'alex', currency: 'GBP', amount: -3000 },
      { member: 'sam', currency: 'GBP', amount: 3000 },
    ]);
  });

  it('refuses transactions that do not add up', () => {
    const code = (c: string) => expect.objectContaining({ code: c });
    expect(() => toPostings({ ...dinner, total: 9001 })).toThrow(code('PAYERS_MISMATCH'));
    expect(() => toPostings({ ...dinner, paidBy: [] })).toThrow(code('PAYERS_MISMATCH'));
    expect(() => toPostings({ ...dinner, total: 0, paidBy: [{ member: 'alex', amount: 0 }] })).toThrow(
      code('NON_POSITIVE_AMOUNT'),
    );
    expect(() =>
      toPostings({
        ...dinner,
        paidBy: [
          { member: 'alex', amount: 4500 },
          { member: 'alex', amount: 4500 },
        ],
      }),
    ).toThrow(code('DUPLICATE_MEMBER'));
    expect(() => toPostings({ ...dinner, currency: 'XXX' })).toThrow(code('UNKNOWN_CURRENCY'));
    expect(() => toPostings({ kind: 'settlement', currency: 'GBP', from: 'sam', to: 'sam', amount: 1 })).toThrow(
      code('SELF_SETTLEMENT'),
    );
  });
});

describe('balancesOf', () => {
  it('sums postings per member and keeps currencies apart', () => {
    const postings = [
      ...toPostings(dinner),
      ...toPostings({ kind: 'settlement', currency: 'GBP', from: 'sam', to: 'alex', amount: 3000 }),
      ...toPostings({ ...dinner, currency: 'EUR', total: 2000, paidBy: [{ member: 'sam', amount: 2000 }] }),
    ];
    const balances = balancesOf(postings);
    expect(Object.fromEntries(balances.get('GBP') ?? [])).toEqual({ alex: 3000, priya: -3000 });
    expect(Object.fromEntries(balances.get('EUR') ?? [])).toEqual({ alex: -667, priya: -667, sam: 1334 });
  });

  it('comes back to nothing when an expense is reversed, which is how edits and deletes work', () => {
    const postings = toPostings(dinner);
    expect(balancesOf([...postings, ...reversePostings(postings)]).size).toBe(0);
  });
});

/** Applies the transfers to the balances, as if everyone paid. */
function afterPaying(balances: ReadonlyMap<string, number>, transfers: readonly Transfer[]): Map<string, number> {
  const left = new Map(balances);
  for (const { from, to, amount } of transfers) {
    left.set(from, (left.get(from) ?? 0) + amount);
    left.set(to, (left.get(to) ?? 0) - amount);
  }
  for (const [member, amount] of left) if (amount === 0) left.delete(member);
  return left;
}

/** The true minimum by brute force: n minus the most zero-sum blocks over every way to partition the group. */
function bruteForceMinimum(amounts: readonly number[]): number {
  const values = amounts.filter((amount) => amount !== 0);
  let most = 0;
  const walk = (index: number, blocks: number[]) => {
    if (index === values.length) {
      if (blocks.every((sum) => sum === 0)) most = Math.max(most, blocks.length);
      return;
    }
    const value = values[index] ?? 0;
    for (let b = 0; b < blocks.length; b++) {
      blocks[b] = (blocks[b] ?? 0) + value;
      walk(index + 1, blocks);
      blocks[b] = (blocks[b] ?? 0) - value;
    }
    walk(index + 1, [...blocks, value]);
  };
  walk(0, []);
  return values.length - most;
}

/** Random balances for `size` people that add up to zero, as any real group's do. */
const zeroSumBalances = (size: { min: number; max: number }) =>
  fc
    .array(fc.integer({ min: -50_000, max: 50_000 }), { minLength: size.min - 1, maxLength: size.max - 1 })
    .map(
      (amounts) =>
        new Map(
          [...amounts, -amounts.reduce((a, b) => a + b, 0)].map((amount, index) => [`m${index}`, amount] as const),
        ),
    );

describe('settleUp', () => {
  it('settles a simple dinner in two payments', () => {
    const balances = balancesOf(toPostings(dinner)).get('GBP') ?? new Map();
    expect(settleUp(balances)).toEqual([
      { from: 'priya', to: 'alex', amount: 3000 },
      { from: 'sam', to: 'alex', amount: 3000 },
    ]);
  });

  it('finds groups that already cancel out, which the greedy method misses', () => {
    // Bea owes exactly what Dev is owed, so one payment settles those two; the other three need two.
    const balances = new Map([
      ['ana', -1000],
      ['bea', -900],
      ['cal', 400],
      ['dev', 900],
      ['eli', 600],
    ]);
    const exact = settleUp(balances);
    expect(exact).toHaveLength(3);
    expect(exact).toContainEqual({ from: 'bea', to: 'dev', amount: 900 });
    expect(afterPaying(balances, exact).size).toBe(0);
    expect(settleUp(balances, 0)).toHaveLength(4); // greedy only
  });

  it('settles nothing when nobody owes anything', () => {
    expect(settleUp(new Map())).toEqual([]);
    expect(settleUp(new Map([['alex', 0]]))).toEqual([]);
  });

  it('refuses balances that do not add up to zero', () => {
    expect(() => settleUp(new Map([['alex', 1]]))).toThrow(expect.objectContaining({ code: 'UNBALANCED' }));
  });

  it('always clears every balance, in at most n − 1 positive payments', () => {
    fc.assert(
      fc.property(zeroSumBalances({ min: 1, max: 40 }), (balances) => {
        const transfers = settleUp(balances);
        expect(afterPaying(balances, transfers).size).toBe(0);
        const owing = [...balances.values()].filter((amount) => amount !== 0).length;
        expect(transfers.length).toBeLessThanOrEqual(Math.max(0, owing - 1));
        for (const transfer of transfers) {
          expect(transfer.amount).toBeGreaterThan(0);
          expect(transfer.from).not.toBe(transfer.to);
        }
      }),
    );
  });

  it('matches the brute-force minimum for small groups', () => {
    // Small amounts make cancelling subgroups common, which is the case worth checking.
    const small = fc.array(fc.integer({ min: -6, max: 6 }), { minLength: 1, maxLength: 7 }).map((amounts) => {
      const all = [...amounts, -amounts.reduce((a, b) => a + b, 0)];
      return new Map(all.map((amount, index) => [`m${index}`, amount] as const));
    });
    fc.assert(
      fc.property(small, (balances) => {
        expect(settleUp(balances).length).toBe(bruteForceMinimum([...balances.values()]));
      }),
      { numRuns: 2000 },
    );
  });

  it('is never worse than greedy', () => {
    fc.assert(
      fc.property(zeroSumBalances({ min: 1, max: 12 }), (balances) => {
        expect(settleUp(balances).length).toBeLessThanOrEqual(settleUp(balances, 0).length);
      }),
    );
  });
});

describe('the whole ledger', () => {
  const members = ['alex', 'bea', 'cal', 'dev', 'eli'];
  const member = fc.constantFrom(...members);
  const someMembers = fc.subarray(members, { minLength: 1 });

  const expense = fc
    .record({
      total: fc.integer({ min: 1, max: 1_000_000 }),
      payer: member,
      split: someMembers,
      currency: fc.constantFrom('GBP', 'EUR', 'JPY'),
    })
    .map(
      ({ total, payer, split, currency }): Expense => ({
        kind: 'expense',
        currency,
        total,
        paidBy: [{ member: payer, amount: total }],
        split: { kind: 'equal', members: split },
      }),
    );

  it('keeps every currency adding up to zero, and settling up always clears it', () => {
    fc.assert(
      fc.property(fc.array(expense, { maxLength: 60 }), (expenses) => {
        const postings: Posting[] = expenses.flatMap(toPostings);
        const balances: Balances = balancesOf(postings);
        for (const [, byMember] of balances) {
          expect([...byMember.values()].reduce((a, b) => a + b, 0)).toBe(0);
          expect(afterPaying(byMember, settleUp(byMember)).size).toBe(0);
        }
      }),
    );
  });
});
