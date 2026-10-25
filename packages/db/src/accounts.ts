import { asUser, type Pool, type Queryable } from './connection.ts';
import { StoreError } from './errors.ts';
import type { Member, User } from './store.ts';
import { newToken, one, sha256 } from './util.ts';

export const SESSION_DAYS = 30;
export const INVITE_DAYS = 7;

export interface Group {
  id: string;
  name: string;
  defaultCurrency: string;
}

export interface InvitePreview {
  groupId: string;
  groupName: string;
  /** Places added by name that nobody has claimed yet: "I'm Sam" joins as that member. */
  unclaimed: { id: string; displayName: string }[];
}

/** Starts a session. The token goes in the cookie; only its hash is stored. */
export async function createSession(pool: Pool, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  const client = await pool.connect();
  try {
    await client.query('insert into sessions (token_hash, user_id, expires_at) values ($1, $2, $3)', [
      await sha256(token),
      userId,
      expiresAt,
    ]);
  } finally {
    client.release();
  }
  return { token, expiresAt };
}

/** The user a session token belongs to, or null if it is unknown or expired. */
export async function userForSession(pool: Pool, token: string): Promise<User | null> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<User>(
      `select u.id, u.email, u.name from sessions s join users u on u.id = s.user_id
       where s.token_hash = $1 and s.expires_at > now()`,
      [await sha256(token)],
    );
    return rows[0] ?? null;
  } finally {
    client.release();
  }
}

export async function deleteSession(pool: Pool, token: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('delete from sessions where token_hash = $1', [await sha256(token)]);
  } finally {
    client.release();
  }
}

/** The groups the user is an active member of. Row-level security does the filtering. */
export async function listGroups(pool: Pool, userId: string): Promise<Group[]> {
  return asUser(pool, userId, async (sql) => {
    const { rows } = await sql.query<Group>(
      `select id, name, default_currency as "defaultCurrency" from groups order by created_at, id`,
    );
    return rows;
  });
}

export async function getGroup(pool: Pool, userId: string, groupId: string): Promise<Group & { members: Member[] }> {
  return asUser(pool, userId, async (sql) => {
    const { rows } = await sql.query<Group>(
      `select id, name, default_currency as "defaultCurrency" from groups where id = $1`,
      [groupId],
    );
    const group = rows[0];
    if (!group) throw new StoreError('NOT_FOUND', 'No such group');
    // Everyone who was ever in the group, so history can still name people who left; `leftAt` tells them apart.
    const members = await sql.query<Member>(
      `select id, display_name as "displayName", user_id as "userId", role, left_at as "leftAt" from members
       where group_id = $1 order by joined_at, id`,
      [groupId],
    );
    return { ...group, members: members.rows };
  });
}

/** Makes an invite link for a group. The token is returned once and never stored. */
export async function createInvite(
  pool: Pool,
  userId: string,
  groupId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
  await asUser(pool, userId, async (sql) => {
    const { rows } = await sql.query('select 1 from groups where id = $1', [groupId]);
    if (rows.length === 0) throw new StoreError('NOT_FOUND', 'No such group');
    await sql.query('insert into invites (token_hash, group_id, created_by, expires_at) values ($1, $2, $3, $4)', [
      await sha256(token),
      groupId,
      userId,
      expiresAt,
    ]);
  });
  return { token, expiresAt };
}

export async function previewInvite(pool: Pool, userId: string, token: string): Promise<InvitePreview> {
  return asUser(pool, userId, async (sql) => {
    const { rows } = await sql.query<{
      group_id: string;
      group_name: string;
      unclaimed_member_id: string | null;
      unclaimed_name: string | null;
    }>('select * from invite_preview($1)', [await sha256(token)]);
    const first = rows[0];
    if (!first) throw new StoreError('NOT_FOUND', 'This invite link is not valid');
    return {
      groupId: first.group_id,
      groupName: first.group_name,
      unclaimed: rows.flatMap((row) =>
        row.unclaimed_member_id ? [{ id: row.unclaimed_member_id, displayName: row.unclaimed_name ?? '' }] : [],
      ),
    };
  });
}

/** Joins the invite's group, as a new member named `displayName` or by claiming an unclaimed place. */
export async function acceptInvite(
  pool: Pool,
  userId: string,
  token: string,
  join: { displayName: string } | { claim: string },
): Promise<{ groupId: string }> {
  return asUser(pool, userId, async (sql) => {
    try {
      const { rows } = await sql.query<{ id: string }>('select accept_invite($1, $2, $3) as id', [
        await sha256(token),
        'displayName' in join ? join.displayName : null,
        'claim' in join ? join.claim : null,
      ]);
      return { groupId: one(rows).id };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'P0002') throw new StoreError('NOT_FOUND', 'This invite link is not valid');
      if (code === '23505') throw new StoreError('CONFLICT', 'That place in the group is already taken');
      throw error;
    }
  });
}

/** The nightly checks: any group whose ledger does not add up (must be none), and expired rows removed. */
export async function nightly(
  pool: Pool,
): Promise<{ unbalanced: { groupId: string; currency: string; total: string }[]; purged: Record<string, number> }> {
  const client = await pool.connect();
  try {
    const audit = await client.query<{ group_id: string; currency: string; total: string }>(
      'select group_id, currency, total::text from audit_ledger()',
    );
    const purged = await client.query<{ sessions: string; invites: string; idempotency_keys: string }>(
      'select * from purge_expired()',
    );
    const counts = one(purged.rows);
    return {
      unbalanced: audit.rows.map((row) => ({ groupId: row.group_id, currency: row.currency, total: row.total })),
      purged: {
        sessions: Number(counts.sessions),
        invites: Number(counts.invites),
        idempotencyKeys: Number(counts.idempotency_keys),
      },
    };
  } finally {
    client.release();
  }
}

/** Deletes a group for everyone. Only the person who started it can; its ledger stays in the database. */
export async function deleteGroup(pool: Pool, userId: string, groupId: string): Promise<void> {
  await asUser(pool, userId, async (sql) => {
    const me = await lockAndFindMe(sql, groupId);
    if (me.role !== 'owner') throw new StoreError('FORBIDDEN', 'Only the person who started the group can delete it');
    await sql.query('update groups set deleted_at = now() where id = $1', [groupId]);
  });
}

/** Leaves a group. Only at a zero balance in every currency, so nobody's debt disappears with them. */
export async function leaveGroup(pool: Pool, userId: string, groupId: string): Promise<void> {
  await asUser(pool, userId, async (sql) => {
    const me = await lockAndFindMe(sql, groupId);
    await assertSettled(sql, groupId, me.id, 'You still owe or are owed money here. Settle up first.');
    await sql.query('update members set left_at = now() where id = $1', [me.id]);
  });
}

/**
 * Removes someone from a group: the person who started it can remove anyone, and anyone can remove a place
 * made by name that nobody has claimed. Again only at a zero balance.
 */
export async function removeMember(pool: Pool, userId: string, groupId: string, memberId: string): Promise<void> {
  await asUser(pool, userId, async (sql) => {
    const me = await lockAndFindMe(sql, groupId);
    const { rows } = await sql.query<{ user_id: string | null }>(
      'select user_id from members where id = $1 and group_id = $2 and left_at is null',
      [memberId, groupId],
    );
    const target = rows[0];
    if (!target) throw new StoreError('NOT_FOUND', 'No such member');
    if (me.role !== 'owner' && target.user_id !== null) {
      throw new StoreError('FORBIDDEN', 'Only the person who started the group can remove people who have joined');
    }
    await assertSettled(sql, groupId, memberId, 'They still owe or are owed money here. Settle up first.');
    await sql.query('update members set left_at = now() where id = $1', [memberId]);
  });
}

/** Takes the group's row lock (as every write does) and returns the caller's own membership. */
async function lockAndFindMe(sql: Queryable, groupId: string): Promise<{ id: string; role: string }> {
  const group = await sql.query('select 1 from groups where id = $1 for update', [groupId]);
  if (group.rows.length === 0) throw new StoreError('NOT_FOUND', 'No such group');
  const { rows } = await sql.query<{ id: string; role: string }>(
    'select id, role from members where group_id = $1 and user_id = app_user_id() and left_at is null',
    [groupId],
  );
  return one(rows);
}

async function assertSettled(sql: Queryable, groupId: string, memberId: string, message: string): Promise<void> {
  const { rows } = await sql.query(
    `select 1 from postings where group_id = $1 and member_id = $2
     group by currency having sum(amount) <> 0 limit 1`,
    [groupId, memberId],
  );
  if (rows.length > 0) throw new StoreError('NOT_SETTLED', message);
}
