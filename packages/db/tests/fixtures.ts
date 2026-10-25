import { randomUUID } from 'node:crypto';
import type { Expense } from '@eventide/ledger';
import { createGroup, upsertUser } from '../src/index.ts';
import type { TestDatabase } from './harness.ts';

export interface Fixture {
  alice: string;
  bob: string;
  /** Has an account, but is not in the group. */
  mallory: string;
  groupId: string;
  members: { alice: string; bob: string; sam: string };
}

/**
 * Alice creates a group; Bob (who has an account) and Sam (who does not) are in it. Mallory has an account and
 * is in no group. Bob is added directly as the owner, since invites arrive with the API.
 */
export async function seed(db: TestDatabase): Promise<Fixture> {
  const alice = (await upsertUser(db.app, 'alice@example.com', 'Alice')).id;
  const bob = (await upsertUser(db.app, 'bob@example.com', 'Bob')).id;
  const mallory = (await upsertUser(db.app, 'mallory@example.com', 'Mallory')).id;
  const { groupId } = await createGroup(db.app, alice, { name: 'Flat 4', currency: 'GBP', displayName: 'Alice' });
  await db.owner.query(`insert into members (group_id, display_name, user_id) values ($1, 'Bob', $2)`, [groupId, bob]);
  await db.owner.query(`insert into members (group_id, display_name) values ($1, 'Sam')`, [groupId]);
  const { rows } = await db.owner.query<{ id: string; display_name: string }>(
    'select id, display_name from members where group_id = $1',
    [groupId],
  );
  const id = (name: string) => rows.find((row) => row.display_name === name)?.id ?? '';
  return { alice, bob, mallory, groupId, members: { alice: id('Alice'), bob: id('Bob'), sam: id('Sam') } };
}

export function dinner(members: Fixture['members'], total = 9000): Expense {
  return {
    kind: 'expense',
    currency: 'GBP',
    total,
    paidBy: [{ member: members.alice, amount: total }],
    split: { kind: 'equal', members: [members.alice, members.bob, members.sam] },
  };
}

export const newIds = () => ({ id: randomUUID(), idempotencyKey: randomUUID() });
