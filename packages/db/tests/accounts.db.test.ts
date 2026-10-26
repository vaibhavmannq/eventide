import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptInvite,
  addMember,
  createGroup,
  createHandoff,
  createInvite,
  createSession,
  deleteSession,
  getGroup,
  listGroups,
  nightly,
  previewInvite,
  takeHandoff,
  upsertUser,
  userForSession,
} from '../src/index.ts';
import { type Fixture, seed } from './fixtures.ts';
import { createTestDatabase, type TestDatabase } from './harness.ts';

let db: TestDatabase;
let f: Fixture;

beforeEach(async () => {
  db = await createTestDatabase();
  f = await seed(db);
});
afterEach(() => db.close());

describe('sessions', () => {
  it('finds the user by token, and stores only a hash of it', async () => {
    const { token } = await createSession(db.app, f.alice);
    expect(await userForSession(db.app, token)).toMatchObject({ id: f.alice, email: 'alice@example.com' });
    const { rows } = await db.owner.query<{ hex: string }>("select encode(token_hash, 'hex') as hex from sessions");
    expect(rows[0]?.hex).not.toContain(Buffer.from(token).toString('hex'));
    expect(await userForSession(db.app, `${token}x`)).toBeNull();
  });

  it('forgets a session that was signed out or has expired', async () => {
    const a = await createSession(db.app, f.alice);
    await deleteSession(db.app, a.token);
    expect(await userForSession(db.app, a.token)).toBeNull();

    const b = await createSession(db.app, f.alice);
    await db.owner.query("update sessions set expires_at = now() - interval '1 second'");
    expect(await userForSession(db.app, b.token)).toBeNull();
  });
});

describe('groups', () => {
  it('lists only the groups you are in', async () => {
    expect((await listGroups(db.app, f.alice)).map((g) => g.name)).toEqual(['Flat 4']);
    expect(await listGroups(db.app, f.mallory)).toEqual([]);
  });

  it('shows a group with its members, and hides it from outsiders', async () => {
    const group = await getGroup(db.app, f.bob, f.groupId);
    expect(group.members.map((m) => m.displayName)).toEqual(['Alice', 'Bob', 'Sam']);
    await expect(getGroup(db.app, f.mallory, f.groupId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('invites', () => {
  it('lets someone join with a link, as a new member', async () => {
    const { token } = await createInvite(db.app, f.alice, f.groupId);
    const preview = await previewInvite(db.app, f.mallory, token);
    expect(preview).toMatchObject({ groupId: f.groupId, groupName: 'Flat 4' });
    expect(preview.unclaimed.map((m) => m.displayName)).toEqual(['Sam']);

    await acceptInvite(db.app, f.mallory, token, { displayName: 'Mal' });
    expect((await listGroups(db.app, f.mallory)).map((g) => g.id)).toEqual([f.groupId]);
    // Joining twice is harmless.
    await acceptInvite(db.app, f.mallory, token, { displayName: 'Mal' });
    expect((await getGroup(db.app, f.alice, f.groupId)).members).toHaveLength(4);
  });

  it('lets someone claim the place made for them, keeping its history', async () => {
    const sam = (await upsertUser(db.app, 'sam@example.com', 'Sam')).id;
    const { token } = await createInvite(db.app, f.alice, f.groupId);
    await acceptInvite(db.app, sam, token, { claim: f.members.sam });
    const members = (await getGroup(db.app, sam, f.groupId)).members;
    expect(members.find((m) => m.id === f.members.sam)?.userId).toBe(sam);

    // The place is now taken.
    await expect(acceptInvite(db.app, f.mallory, token, { claim: f.members.sam })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('refuses unknown and expired links, and invites from outsiders', async () => {
    await expect(previewInvite(db.app, f.mallory, 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const { token } = await createInvite(db.app, f.alice, f.groupId);
    await db.owner.query("update invites set expires_at = now() - interval '1 second'");
    await expect(acceptInvite(db.app, f.mallory, token, { displayName: 'Mal' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(createInvite(db.app, f.mallory, f.groupId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('cannot claim a place in a different group', async () => {
    const other = await addMember(db.app, f.alice, f.groupId, 'Pat');
    const { groupId: second } = await createGroup(db.app, f.bob, { name: 'Trip', currency: 'EUR', displayName: 'Bob' });
    const { token } = await createInvite(db.app, f.bob, second);
    await expect(acceptInvite(db.app, f.mallory, token, { claim: other.id })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

describe('desktop sign-in handoffs', () => {
  it('can be used once, and stores only a hash of the code', async () => {
    const code = await createHandoff(db.app, f.alice, 'the-challenge', '/groups');
    const { rows } = await db.owner.query('select code_hash from sign_in_handoffs');
    expect(Buffer.from(rows[0].code_hash).toString()).not.toContain(code);
    expect(await takeHandoff(db.app, code)).toEqual({ userId: f.alice, challenge: 'the-challenge', next: '/groups' });
    expect(await takeHandoff(db.app, code)).toBeNull();
  });

  it('is refused once expired, and is used up by trying', async () => {
    const code = await createHandoff(db.app, f.alice, 'c', '/');
    await db.owner.query("update sign_in_handoffs set expires_at = now() - interval '1 second'");
    expect(await takeHandoff(db.app, code)).toBeNull();
    expect((await db.owner.query('select 1 from sign_in_handoffs')).rowCount).toBe(0);
    expect(await takeHandoff(db.app, 'never-issued')).toBeNull();
  });
});

describe('the nightly job', () => {
  it('finds no unbalanced ledger, and purges what has expired', async () => {
    await createSession(db.app, f.alice);
    await createInvite(db.app, f.alice, f.groupId);
    await createHandoff(db.app, f.alice, 'challenge', '/');
    await db.owner.query("update sessions set expires_at = now() - interval '1 second'");
    await db.owner.query("update invites set expires_at = now() - interval '1 second'");
    await db.owner.query("update sign_in_handoffs set expires_at = now() - interval '1 second'");
    expect(await nightly(db.app)).toEqual({
      unbalanced: [],
      purged: { sessions: 1, invites: 1, idempotencyKeys: 0, handoffs: 1 },
    });
  });

  it('reports a ledger that does not add up, across every group', async () => {
    // Only possible by disabling the trigger as the owner: exactly the kind of thing the audit is there to catch.
    await db.owner.query('alter table postings disable trigger postings_balanced');
    await db.owner.query(
      `with t as (insert into transactions (id, group_id, kind, revision, occurred_on, currency, body, created_by, updated_by)
                  values (gen_random_uuid(), $1, 'expense', 1, '2026-10-25', 'GBP', '{}', $2, $2) returning id),
            e as (insert into entries (group_id, seq, kind, transaction_id, revision, created_by)
                  select $1, 99, 'create', id, 1, $2 from t returning id)
       insert into postings (entry_id, group_id, member_id, currency, amount) select id, $1, $3, 'GBP', 5 from e`,
      [f.groupId, f.alice, f.members.alice],
    );
    expect((await nightly(db.app)).unbalanced).toEqual([{ groupId: f.groupId, currency: 'GBP', total: '5' }]);
  });
});
