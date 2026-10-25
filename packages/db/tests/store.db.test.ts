import { randomUUID } from 'node:crypto';
import { settleUp } from '@eventide/ledger';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  changesSince,
  deleteTransaction,
  editTransaction,
  getBalances,
  listMembers,
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

const gbp = async (userId = f.alice) =>
  Object.fromEntries((await getBalances(db.app, userId, f.groupId)).get('GBP') ?? []);

const record = (input: Partial<Parameters<typeof recordTransaction>[2]> = {}) =>
  recordTransaction(db.app, f.alice, {
    groupId: f.groupId,
    ...newIds(),
    description: 'Dinner',
    occurredOn: '2026-10-25',
    transaction: dinner(f.members),
    ...input,
  });

describe('recording', () => {
  it('records an expense and updates balances', async () => {
    const saved = await record();
    expect(saved).toMatchObject({ revision: 1, deleted: false, seq: 1, description: 'Dinner' });
    expect(await gbp()).toEqual({ [f.members.alice]: 6000, [f.members.bob]: -3000, [f.members.sam]: -3000 });
  });

  it('records a payment back, and settling up reaches zero', async () => {
    await record();
    for (const { from, to, amount } of settleUp(
      (await getBalances(db.app, f.alice, f.groupId)).get('GBP') ?? new Map(),
    )) {
      await record({ transaction: { kind: 'settlement', currency: 'GBP', from, to, amount } });
    }
    expect(await gbp()).toEqual({});
  });

  it('refuses someone who is not in the group, and anyone outside it', async () => {
    await expect(
      record({ transaction: { ...dinner(f.members), paidBy: [{ member: randomUUID(), amount: 9000 }] } }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_MEMBER' });
    await expect(
      recordTransaction(db.app, f.mallory, {
        groupId: f.groupId,
        ...newIds(),
        description: '',
        occurredOn: '2026-10-25',
        transaction: dinner(f.members),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('passes the ledger rules through, and writes nothing when they fail', async () => {
    await expect(record({ transaction: { ...dinner(f.members), total: 9001 } })).rejects.toMatchObject({
      code: 'PAYERS_MISMATCH',
    });
    expect((await changesSince(db.app, f.alice, f.groupId, 0)).length).toBe(0);
  });

  it('refuses an id that is already taken', async () => {
    const { id } = await record();
    await expect(record({ id })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });

  it('lets members add someone without an account, who can then be split with', async () => {
    const pat = await addMember(db.app, f.bob, f.groupId, 'Pat');
    expect((await listMembers(db.app, f.alice, f.groupId)).map((m) => m.displayName)).toContain('Pat');
    const split = { kind: 'equal', members: [f.members.alice, pat.id] } as const;
    await record({ transaction: { ...dinner(f.members), split } });
    expect((await gbp())[pat.id]).toBe(-4500);
    await expect(addMember(db.app, f.mallory, f.groupId, 'Eve')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('idempotency', () => {
  it('returns the same result for a retried request and writes once', async () => {
    const ids = newIds();
    const first = await record(ids);
    const again = await record(ids);
    expect(again).toEqual(first);
    expect(await changesSince(db.app, f.alice, f.groupId, 0)).toHaveLength(1);
    expect(await gbp()).toEqual({ [f.members.alice]: 6000, [f.members.bob]: -3000, [f.members.sam]: -3000 });
  });

  it('refuses the same key with a different request', async () => {
    const ids = newIds();
    await record(ids);
    await expect(record({ ...ids, description: 'Lunch' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
  });

  it('keeps keys per user: the same key from someone else is a different request', async () => {
    const { idempotencyKey } = newIds();
    await record({ idempotencyKey });
    await expect(
      recordTransaction(db.app, f.bob, {
        groupId: f.groupId,
        id: randomUUID(),
        idempotencyKey,
        description: 'Dinner',
        occurredOn: '2026-10-25',
        transaction: dinner(f.members),
      }),
    ).resolves.toMatchObject({ seq: 2 });
  });

  it('forgets a key when the request failed, so it can be retried after fixing', async () => {
    const ids = newIds();
    await expect(record({ ...ids, transaction: { ...dinner(f.members), total: 1 } })).rejects.toThrow();
    // A different body under the same key is fine: the failed attempt left nothing behind.
    await expect(record(ids)).resolves.toMatchObject({ seq: 1 });
  });
});

describe('editing and deleting', () => {
  it('replaces an expense by appending its reversal and the new version', async () => {
    const saved = await record();
    const edited = await editTransaction(db.app, f.bob, {
      ...saved,
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      transaction: dinner(f.members, 6000),
    });
    expect(edited).toMatchObject({ revision: 2, seq: 2 });
    expect(await gbp()).toEqual({ [f.members.alice]: 4000, [f.members.bob]: -2000, [f.members.sam]: -2000 });
    const { rows } = await db.owner.query('select count(*)::int as n from postings');
    expect(rows[0]).toEqual({ n: 3 + 3 + 3 }); // created, reversed, re-created: nothing rewritten
  });

  it('refuses an edit of a version that is no longer current, and says what is', async () => {
    const saved = await record();
    const edit = { ...saved, expectedRevision: 1, transaction: dinner(f.members, 6000) };
    await editTransaction(db.app, f.alice, { ...edit, idempotencyKey: randomUUID() });
    await expect(editTransaction(db.app, f.bob, { ...edit, idempotencyKey: randomUUID() })).rejects.toMatchObject({
      code: 'CONFLICT',
      current: expect.objectContaining({ revision: 2 }),
    });
  });

  it('refuses turning an expense into a payment', async () => {
    const saved = await record();
    await expect(
      editTransaction(db.app, f.alice, {
        ...saved,
        idempotencyKey: randomUUID(),
        expectedRevision: 1,
        transaction: { kind: 'settlement', currency: 'GBP', from: f.members.bob, to: f.members.alice, amount: 1 },
      }),
    ).rejects.toMatchObject({ code: 'KIND_MISMATCH' });
  });

  it('deletes by reversal: balances return to zero and the history stays', async () => {
    const saved = await record();
    const deleted = await deleteTransaction(db.app, f.alice, {
      groupId: f.groupId,
      id: saved.id,
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
    });
    expect(deleted).toMatchObject({ revision: 2, deleted: true });
    expect(await gbp()).toEqual({});
    await expect(
      deleteTransaction(db.app, f.alice, {
        groupId: f.groupId,
        id: saved.id,
        idempotencyKey: randomUUID(),
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reverses what was written, not what the body would compute today', async () => {
    const saved = await record();
    // Simulate the splitting rules changing after the expense was recorded: the stored body now says
    // something different from the postings that were actually written.
    await db.owner.query(`update transactions set body = jsonb_set(body, '{total}', '1') where id = $1`, [saved.id]);
    await deleteTransaction(db.app, f.alice, {
      groupId: f.groupId,
      id: saved.id,
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
    });
    expect(await gbp()).toEqual({});
  });
});

describe('the change feed', () => {
  it('lists every change in order, and paging by the last seq misses nothing', async () => {
    const a = await record();
    await record();
    await editTransaction(db.app, f.alice, {
      ...a,
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      description: 'Dinner (fixed)',
    });
    await deleteTransaction(db.app, f.alice, {
      groupId: f.groupId,
      id: a.id,
      idempotencyKey: randomUUID(),
      expectedRevision: 2,
    });

    const all = await changesSince(db.app, f.bob, f.groupId, 0);
    expect(all.map((c) => [c.seq, c.kind])).toEqual([
      [1, 'create'],
      [2, 'create'],
      [3, 'edit'],
      [4, 'delete'],
    ]);
    expect(all[2]?.view.description).toBe('Dinner (fixed)');

    const firstPage = await changesSince(db.app, f.bob, f.groupId, 0, 2);
    const secondPage = await changesSince(db.app, f.bob, f.groupId, firstPage.at(-1)?.seq ?? 0, 2);
    expect([...firstPage, ...secondPage]).toEqual(all);
  });

  it('shows outsiders nothing', async () => {
    await record();
    await expect(changesSince(db.app, f.mallory, f.groupId, 0)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
