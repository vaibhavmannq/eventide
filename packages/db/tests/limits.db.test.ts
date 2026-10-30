import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptInvite,
  addMember,
  createGroup,
  createInvite,
  deleteGroup,
  LIMITS,
  recordTransaction,
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

const today = '2026-10-30';
const limited = { code: 'LIMIT_REACHED' };

/** Writes `count` changes for `userId` straight into the ledger, as if made earlier today. */
async function changesMadeToday(userId: string, count: number): Promise<void> {
  const { id } = await recordTransaction(db.app, userId, {
    ...newIds(),
    groupId: f.groupId,
    description: 'First',
    occurredOn: today,
    transaction: dinner(f.members),
  });
  await db.owner.query(
    `insert into entries (group_id, seq, kind, transaction_id, revision, created_by)
     select $1, 1000000 + n, 'edit', $2, 1, $3 from generate_series(1, $4::int) n`,
    [f.groupId, id, userId, count - 1],
  );
}

describe('changes per person per day', () => {
  it('refuses the next change at the limit, but replays an earlier one and lets others carry on', async () => {
    const first = {
      ...newIds(),
      groupId: f.groupId,
      description: 'Kept',
      occurredOn: today,
      transaction: dinner(f.members),
    };
    await recordTransaction(db.app, f.alice, first);
    await changesMadeToday(f.alice, LIMITS.changesPerPersonPerDay - 1);

    const next = {
      ...newIds(),
      groupId: f.groupId,
      description: 'One more',
      occurredOn: today,
      transaction: dinner(f.members),
    };
    await expect(recordTransaction(db.app, f.alice, next)).rejects.toMatchObject(limited);
    // A retry of a change that already went through is not a new change.
    await expect(recordTransaction(db.app, f.alice, first)).resolves.toMatchObject({ description: 'Kept' });
    // The limit is Alice's, not the group's.
    await expect(recordTransaction(db.app, f.bob, next)).resolves.toMatchObject({ description: 'One more' });
  });

  it('still counts changes in a group that has since been deleted', async () => {
    await changesMadeToday(f.alice, LIMITS.changesPerPersonPerDay);
    await deleteGroup(db.app, f.alice, f.groupId);
    const { groupId } = await createGroup(db.app, f.alice, { name: 'Fresh', currency: 'GBP', displayName: 'Alice' });
    const { rows } = await db.owner.query<{ id: string }>('select id from members where group_id = $1', [groupId]);
    const alice = rows[0]?.id ?? '';
    await expect(
      recordTransaction(db.app, f.alice, {
        ...newIds(),
        groupId,
        description: 'Coffee',
        occurredOn: today,
        transaction: {
          kind: 'expense',
          currency: 'GBP',
          total: 300,
          paidBy: [{ member: alice, amount: 300 }],
          split: { kind: 'equal', members: [alice] },
        },
      }),
    ).rejects.toMatchObject(limited);
  });
});

describe('groups per person', () => {
  it('refuses starting a group once you have started the daily number, deleted or not', async () => {
    // The fixture's group was started by Alice today.
    for (let n = 1; n < LIMITS.groupsStartedPerPersonPerDay; n++) {
      const { groupId } = await createGroup(db.app, f.alice, { name: `Trip ${n}`, currency: 'EUR', displayName: 'A' });
      await deleteGroup(db.app, f.alice, groupId);
    }
    await expect(
      createGroup(db.app, f.alice, { name: 'One too many', currency: 'EUR', displayName: 'A' }),
    ).rejects.toMatchObject(limited);
  });

  it('refuses a new group while you are in the most groups at once, until you leave one', async () => {
    await db.owner.query(
      `with g as (
         insert into groups (name, default_currency, created_by, created_at)
         select 'Old ' || n, 'GBP', $1, now() - interval '3 days' from generate_series(1, $2::int) n
         returning id
       )
       insert into members (group_id, display_name, user_id, role) select id, 'Mallory', $1, 'owner' from g`,
      [f.mallory, LIMITS.groupsPerPerson],
    );
    await expect(
      createGroup(db.app, f.mallory, { name: 'Another', currency: 'GBP', displayName: 'Mallory' }),
    ).rejects.toMatchObject(limited);

    await db.owner.query(
      `update members set left_at = now() where id = (select id from members where user_id = $1 limit 1)`,
      [f.mallory],
    );
    await expect(
      createGroup(db.app, f.mallory, { name: 'Another', currency: 'GBP', displayName: 'Mallory' }),
    ).resolves.toBeTruthy();
  });
});

describe('people per group', () => {
  async function fillGroup(): Promise<void> {
    const { rows } = await db.owner.query<{ count: string }>(
      'select count(*)::text as count from members where group_id = $1 and left_at is null',
      [f.groupId],
    );
    for (let n = Number(rows[0]?.count); n < LIMITS.peoplePerGroup; n++) {
      await addMember(db.app, f.alice, f.groupId, `Friend ${n}`);
    }
  }

  it('refuses adding someone by name to a full group', async () => {
    await fillGroup();
    await expect(addMember(db.app, f.alice, f.groupId, 'One more')).rejects.toMatchObject(limited);
  });

  it('refuses a new person joining a full group by invite, but lets them claim a place already made', async () => {
    const { token } = await createInvite(db.app, f.alice, f.groupId);
    await fillGroup();
    await expect(acceptInvite(db.app, f.mallory, token, { displayName: 'Mal' })).rejects.toMatchObject(limited);
    // Sam is a place in the group nobody has claimed: claiming it adds nobody.
    await expect(acceptInvite(db.app, f.mallory, token, { claim: f.members.sam })).resolves.toEqual({
      groupId: f.groupId,
    });
  });

  it('refuses someone rejoining a full group', async () => {
    const { token } = await createInvite(db.app, f.alice, f.groupId);
    await db.owner.query('update members set left_at = now() where id = $1', [f.members.bob]);
    await fillGroup();
    await expect(acceptInvite(db.app, f.bob, token, { displayName: 'Bob' })).rejects.toMatchObject(limited);
  });
});

describe('invite links per group', () => {
  it('refuses another link while the most are still open, until one expires', async () => {
    for (let n = 0; n < LIMITS.openInvitesPerGroup; n++) await createInvite(db.app, f.alice, f.groupId);
    await expect(createInvite(db.app, f.alice, f.groupId)).rejects.toMatchObject(limited);

    await db.owner.query(
      `update invites set expires_at = now() - interval '1 second'
       where token_hash = (select token_hash from invites where group_id = $1 limit 1)`,
      [f.groupId],
    );
    await expect(createInvite(db.app, f.alice, f.groupId)).resolves.toBeTruthy();
  });
});
