import { randomUUID } from 'node:crypto';
import { balancesOf, toPostings } from '@eventide/ledger';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  changesSince,
  editTransaction,
  getBalances,
  type Pool,
  type PoolClient,
  recordTransaction,
  StoreError,
} from '../src/index.ts';
import { dinner, type Fixture, newIds, seed } from './fixtures.ts';
import { createTestDatabase, type TestDatabase } from './harness.ts';

/**
 * The claims in docs/DESIGN.md §7, tested with real concurrent connections (up to 20 at once) against one group.
 */
let db: TestDatabase;
let f: Fixture;

beforeEach(async () => {
  db = await createTestDatabase();
  f = await seed(db);
});
afterEach(() => db.close());

const WRITERS = 50;

function write(userId: string, ids = newIds(), total = 900 + Math.floor(Math.random() * 9000)) {
  return recordTransaction(db.app, userId, {
    groupId: f.groupId,
    ...ids,
    description: 'Concurrent',
    occurredOn: '2026-10-25',
    transaction: dinner(f.members, total),
  });
}

describe('many people writing to one group at once', () => {
  it('keeps every write, numbers them without gaps, and the balances still add up to zero', async () => {
    const users = [f.alice, f.bob];
    const results = await Promise.all(Array.from({ length: WRITERS }, (_, i) => write(users[i % 2] ?? f.alice)));

    expect(results.map((r) => r.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: WRITERS }, (_, i) => i + 1));
    // The stored balances are exactly what the ledger computes from the fifty writes: nothing lost or doubled.
    const balances = await getBalances(db.app, f.alice, f.groupId);
    expect(balances).toEqual(balancesOf(results.flatMap((r) => toPostings(r.transaction))));
    const gbp = balances.get('GBP') ?? new Map();
    expect([...gbp.values()].reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('applies a request sent many times at once exactly once', async () => {
    const ids = newIds();
    const results = await Promise.all(Array.from({ length: 20 }, () => write(f.alice, ids, 9000)));

    for (const result of results) expect(result).toEqual(results[0]);
    expect(await changesSince(db.app, f.alice, f.groupId, 0)).toHaveLength(1);
    expect(Object.fromEntries((await getBalances(db.app, f.alice, f.groupId)).get('GBP') ?? [])).toEqual({
      [f.members.alice]: 6000,
      [f.members.bob]: -3000,
      [f.members.sam]: -3000,
    });
  });

  it('lets exactly one of several simultaneous edits of the same version win', async () => {
    const saved = await write(f.alice);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        editTransaction(db.app, i % 2 ? f.bob : f.alice, {
          ...saved,
          idempotencyKey: randomUUID(),
          expectedRevision: 1,
          transaction: dinner(f.members, 1000 + i),
        }),
      ),
    );

    const won = outcomes.filter((o) => o.status === 'fulfilled');
    const lost = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(9);
    for (const { reason } of lost) expect(reason).toBeInstanceOf(StoreError);
    for (const { reason } of lost) expect((reason as StoreError).code).toBe('CONFLICT');

    // The balances are exactly the winner's version: no lost update, no double reversal.
    const winner = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof write>>>).value;
    expect(await getBalances(db.app, f.alice, f.groupId)).toEqual(balancesOf(toPostings(winner.transaction)));
  });

  it('never lets a later change become visible before an earlier one commits', async () => {
    // Alice's write takes the next seq and is then held just before commit. Bob writes meanwhile. If Bob's
    // change (a later seq) could commit first, a client polling now would see it, remember its seq, and never
    // ask for Alice's: the change would be lost to that client forever. With the group row lock, Bob waits.
    let release = () => {};
    let atCommit = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reachedCommit = new Promise<void>((resolve) => {
      atCommit = resolve;
    });
    const held: Pool = {
      async connect() {
        const client = await db.app.connect();
        return {
          release: (destroy) => client.release(destroy),
          query: async (text: string, values?: readonly unknown[]) => {
            if (text === 'commit') {
              atCommit();
              await released;
            }
            return client.query(text, values as unknown[]);
          },
        } as PoolClient;
      },
    };

    const alice = recordTransaction(held, f.alice, {
      groupId: f.groupId,
      ...newIds(),
      description: 'Held',
      occurredOn: '2026-10-25',
      transaction: dinner(f.members),
    });
    await reachedCommit;
    const bob = write(f.bob);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300)); // ample time for Bob to commit, if he could
      expect(await changesSince(db.app, f.bob, f.groupId, 0)).toEqual([]);
    } finally {
      release();
    }
    const [a, b] = await Promise.all([alice, bob]);
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect((await changesSince(db.app, f.bob, f.groupId, 0)).map((change) => change.seq)).toEqual([1, 2]);
  });
});
