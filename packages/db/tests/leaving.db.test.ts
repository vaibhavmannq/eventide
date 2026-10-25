import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  deleteGroup,
  getGroup,
  leaveGroup,
  listGroups,
  recordTransaction,
  removeMember,
} from '../src/index.ts';
import { dinner, type Fixture, newIds, seed } from './fixtures.ts';
import { createTestDatabase, type TestDatabase } from './harness.ts';

let db: TestDatabase;
let f: Fixture;

beforeEach(async () => {
  db = await createTestDatabase();
  f = await seed(db);
});
afterEach(() => db.close());

const settle = (from: string, to: string, amount: number) =>
  recordTransaction(db.app, f.alice, {
    groupId: f.groupId,
    ...newIds(),
    description: '',
    occurredOn: '2026-10-25',
    transaction: { kind: 'settlement', currency: 'GBP', from, to, amount },
  });

describe('leaving a group', () => {
  it('is refused while you owe money, and allowed once you are even', async () => {
    await recordTransaction(db.app, f.alice, {
      groupId: f.groupId,
      ...newIds(),
      description: 'Dinner',
      occurredOn: '2026-10-25',
      transaction: dinner(f.members),
    });
    await expect(leaveGroup(db.app, f.bob, f.groupId)).rejects.toMatchObject({ code: 'NOT_SETTLED' });
    await settle(f.members.bob, f.members.alice, 3000);
    await leaveGroup(db.app, f.bob, f.groupId);
    expect(await listGroups(db.app, f.bob)).toEqual([]);
    // Bob is still named in the history, marked as having left.
    const bob = (await getGroup(db.app, f.alice, f.groupId)).members.find((m) => m.id === f.members.bob);
    expect(bob?.leftAt).toBeTruthy();
  });

  it('stops anyone splitting new expenses with someone who left', async () => {
    await leaveGroup(db.app, f.bob, f.groupId);
    await expect(
      recordTransaction(db.app, f.alice, {
        groupId: f.groupId,
        ...newIds(),
        description: 'Dinner',
        occurredOn: '2026-10-25',
        transaction: dinner(f.members),
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_MEMBER' });
  });
});

describe('removing someone', () => {
  it('lets anyone remove an unclaimed place at a zero balance, but only the creator remove a person', async () => {
    const pat = await addMember(db.app, f.bob, f.groupId, 'Pat');
    await removeMember(db.app, f.bob, f.groupId, pat.id);
    await expect(removeMember(db.app, f.bob, f.groupId, f.members.alice)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await removeMember(db.app, f.alice, f.groupId, f.members.bob);
    const active = (await getGroup(db.app, f.alice, f.groupId)).members.filter((m) => !m.leftAt);
    expect(active.map((m) => m.displayName)).toEqual(['Alice', 'Sam']);
  });

  it('is refused while they owe money', async () => {
    await recordTransaction(db.app, f.alice, {
      groupId: f.groupId,
      ...newIds(),
      description: 'Dinner',
      occurredOn: '2026-10-25',
      transaction: dinner(f.members),
    });
    await expect(removeMember(db.app, f.alice, f.groupId, f.members.sam)).rejects.toMatchObject({
      code: 'NOT_SETTLED',
    });
  });

  it('hides the group from outsiders as before', async () => {
    await expect(removeMember(db.app, f.mallory, f.groupId, f.members.sam)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(removeMember(db.app, f.alice, f.groupId, randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('deleting a group', () => {
  it('only the creator can, and then it is gone for everyone while its ledger stays', async () => {
    await recordTransaction(db.app, f.alice, {
      groupId: f.groupId,
      ...newIds(),
      description: 'Dinner',
      occurredOn: '2026-10-25',
      transaction: dinner(f.members),
    });
    await expect(deleteGroup(db.app, f.bob, f.groupId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await deleteGroup(db.app, f.alice, f.groupId);
    expect(await listGroups(db.app, f.alice)).toEqual([]);
    expect(await listGroups(db.app, f.bob)).toEqual([]);
    await expect(getGroup(db.app, f.bob, f.groupId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const { rows } = await db.owner.query('select count(*)::int as n from postings where group_id = $1', [f.groupId]);
    expect(rows[0]).toEqual({ n: 3 });
  });
});
