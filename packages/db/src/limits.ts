import type { Queryable } from './connection.ts';
import { StoreError } from './errors.ts';
import { one } from './util.ts';

/**
 * What one person may do (migration 0006). Sign-up is open, and the free allowances are shared by everyone, so
 * no single account may use more than a person splitting costs ever would. Real use is a few dozen changes a day.
 */
export const LIMITS = {
  /** Groups you are in at once. */
  groupsPerPerson: 50,
  /** People in one group, added by name or joining by invite. Also in accept_invite (migration 0006). */
  peoplePerGroup: 50,
  /** Invite links for one group that have not expired yet. */
  openInvitesPerGroup: 20,
  /** Expenses and payments you add, edit or delete, in any group, in the last 24 hours. */
  changesPerPersonPerDay: 2000,
  /** Groups you start in the last 24 hours, kept or deleted since. */
  groupsStartedPerPersonPerDay: 20,
} as const;

async function today(sql: Queryable): Promise<{ changes: number; groupsStarted: number }> {
  const { rows } = await sql.query<{ changes: string; groups_started: string }>(
    'select changes::text, groups_started::text from my_activity_today()',
  );
  const row = one(rows);
  return { changes: Number(row.changes), groupsStarted: Number(row.groups_started) };
}

/** Before an expense or payment is added, edited or deleted. */
export async function checkChangesToday(sql: Queryable): Promise<void> {
  if ((await today(sql)).changes >= LIMITS.changesPerPersonPerDay) {
    throw new StoreError(
      'LIMIT_REACHED',
      `You've made ${LIMITS.changesPerPersonPerDay} changes in the last 24 hours, the most Eventide allows. Try again tomorrow.`,
    );
  }
}

/** Before a group is started. */
export async function checkNewGroup(sql: Queryable, userId: string): Promise<void> {
  if ((await today(sql)).groupsStarted >= LIMITS.groupsStartedPerPersonPerDay) {
    throw new StoreError(
      'LIMIT_REACHED',
      `You've started ${LIMITS.groupsStartedPerPersonPerDay} groups in the last 24 hours, the most Eventide allows. Try again tomorrow.`,
    );
  }
  const { rows } = await sql.query<{ count: string }>(
    'select count(*)::text as count from members where user_id = $1 and left_at is null',
    [userId],
  );
  if (Number(one(rows).count) >= LIMITS.groupsPerPerson) {
    throw new StoreError(
      'LIMIT_REACHED',
      `You're in ${LIMITS.groupsPerPerson} groups, the most Eventide allows. Leave or delete one to start another.`,
    );
  }
}

/** Before someone is added to a group by name. */
export async function checkNewPerson(sql: Queryable, groupId: string): Promise<void> {
  const { rows } = await sql.query<{ count: string }>(
    'select count(*)::text as count from members where group_id = $1 and left_at is null',
    [groupId],
  );
  if (Number(one(rows).count) >= LIMITS.peoplePerGroup) {
    throw new StoreError('LIMIT_REACHED', `This group already has ${LIMITS.peoplePerGroup} people, the most it can.`);
  }
}

/** Before an invite link is made. */
export async function checkNewInvite(sql: Queryable, groupId: string): Promise<void> {
  const { rows } = await sql.query<{ count: string }>(
    'select count(*)::text as count from invites where group_id = $1 and expires_at > now()',
    [groupId],
  );
  if (Number(one(rows).count) >= LIMITS.openInvitesPerGroup) {
    throw new StoreError(
      'LIMIT_REACHED',
      `This group has ${LIMITS.openInvitesPerGroup} invite links that still work. Use one of those, or wait for one to expire.`,
    );
  }
}
