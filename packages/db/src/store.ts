import {
  type Balances,
  balancesOf,
  type MemberId,
  type Posting,
  reversePostings,
  type Transaction,
  toPostings,
} from '@eventide/ledger';
import { asUser, type Pool, type Queryable } from './connection.ts';
import { StoreError } from './errors.ts';
import { canonicalJson, equalBytes, minor, one, sha256 } from './util.ts';

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Member {
  id: string;
  displayName: string;
  userId: string | null;
  role: 'owner' | 'member';
}

/** A transaction as it stands now, which is also what a write returns and what a retried write returns again. */
export interface TransactionView {
  id: string;
  groupId: string;
  revision: number;
  deleted: boolean;
  description: string;
  occurredOn: string;
  transaction: Transaction;
  /** The group sequence number of the change that produced this version. */
  seq: number;
}

export interface Change {
  seq: number;
  kind: 'create' | 'edit' | 'delete';
  view: TransactionView;
}

export interface RecordInput {
  groupId: string;
  /** Made by the app, so an expense created offline already has its id. */
  id: string;
  idempotencyKey: string;
  description: string;
  /** YYYY-MM-DD, the day it happened in the user's own calendar. */
  occurredOn: string;
  transaction: Transaction;
}

export interface EditInput extends RecordInput {
  /** The revision the user was looking at. If it is no longer current, the edit is refused with CONFLICT. */
  expectedRevision: number;
}

export interface DeleteInput {
  groupId: string;
  id: string;
  idempotencyKey: string;
  expectedRevision: number;
}

/** Signing in: the user with this email, created on first sign-in. Runs outside any group, so no user context. */
export async function upsertUser(pool: Pool, email: string, name: string): Promise<User> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<User>(
      `insert into users (email, name) values (lower($1), $2)
       on conflict (email) do update set name = users.name  -- a no-op update, so the row comes back
       returning id, email, name`,
      [email, name],
    );
    return one(rows);
  } finally {
    client.release();
  }
}

export async function createGroup(
  pool: Pool,
  userId: string,
  input: { name: string; currency: string; displayName: string },
): Promise<{ groupId: string }> {
  return asUser(pool, userId, async (sql) => {
    const { rows } = await sql.query<{ id: string }>('select create_group($1, $2, $3) as id', [
      input.name,
      input.currency,
      input.displayName,
    ]);
    return { groupId: one(rows).id };
  });
}

/** Adds someone to a group by name; they may have no account yet. Only members can add members. */
export async function addMember(pool: Pool, userId: string, groupId: string, displayName: string): Promise<Member> {
  return asUser(pool, userId, async (sql) => {
    await lockGroup(sql, groupId);
    const { rows } = await sql.query<Member>(
      `insert into members (group_id, display_name) values ($1, $2)
       returning id, display_name as "displayName", user_id as "userId", role`,
      [groupId, displayName],
    );
    return one(rows);
  });
}

export async function listMembers(pool: Pool, userId: string, groupId: string): Promise<Member[]> {
  return asUser(pool, userId, async (sql) => {
    const { rows } = await sql.query<Member>(
      `select id, display_name as "displayName", user_id as "userId", role from members
       where group_id = $1 and left_at is null order by joined_at, id`,
      [groupId],
    );
    if (rows.length === 0) throw new StoreError('NOT_FOUND', 'No such group');
    return rows;
  });
}

/** Adds an expense or a payment. */
export async function recordTransaction(pool: Pool, userId: string, input: RecordInput): Promise<TransactionView> {
  return asUser(pool, userId, (sql) =>
    idempotent(sql, userId, input.idempotencyKey, { op: 'record', ...input }, async () => {
      const seq = await nextSeq(sql, input.groupId);
      const postings = await validate(sql, input.groupId, input.transaction);

      const inserted = await sql.query(
        `insert into transactions
           (id, group_id, kind, revision, description, occurred_on, currency, body, created_by, updated_by)
         values ($1, $2, $3, 1, $4, $5, $6, $7, $8, $8)
         on conflict (id) do nothing`,
        [
          input.id,
          input.groupId,
          input.transaction.kind,
          input.description,
          input.occurredOn,
          input.transaction.currency,
          input.transaction,
          userId,
        ],
      );
      if (inserted.rowCount === 0) throw new StoreError('ALREADY_EXISTS', `Transaction ${input.id} already exists`);

      await appendEntry(sql, userId, { ...input, seq, kind: 'create', revision: 1, deleted: false, postings });
      return view(input, { revision: 1, deleted: false, seq });
    }),
  );
}

/** Replaces an expense or payment, if nobody else has changed it since `expectedRevision`. */
export async function editTransaction(pool: Pool, userId: string, input: EditInput): Promise<TransactionView> {
  return asUser(pool, userId, (sql) =>
    idempotent(sql, userId, input.idempotencyKey, { op: 'edit', ...input }, async () => {
      const seq = await nextSeq(sql, input.groupId);
      const current = await lockCurrent(sql, input.groupId, input.id, input.expectedRevision);
      if (current.transaction.kind !== input.transaction.kind) {
        throw new StoreError('KIND_MISMATCH', 'An expense cannot be edited into a payment, or the reverse');
      }
      const postings = [
        ...reversePostings(await netPostings(sql, input.id)),
        ...(await validate(sql, input.groupId, input.transaction)),
      ];
      const revision = current.revision + 1;

      await sql.query(
        `update transactions set revision = $2, description = $3, occurred_on = $4, currency = $5, body = $6,
           updated_by = $7, updated_at = now()
         where id = $1`,
        [
          input.id,
          revision,
          input.description,
          input.occurredOn,
          input.transaction.currency,
          input.transaction,
          userId,
        ],
      );
      await appendEntry(sql, userId, { ...input, seq, kind: 'edit', revision, deleted: false, postings });
      return view(input, { revision, deleted: false, seq });
    }),
  );
}

/** Deletes an expense or payment by appending its reversal; its history stays. */
export async function deleteTransaction(pool: Pool, userId: string, input: DeleteInput): Promise<TransactionView> {
  return asUser(pool, userId, (sql) =>
    idempotent(sql, userId, input.idempotencyKey, { op: 'delete', ...input }, async () => {
      const seq = await nextSeq(sql, input.groupId);
      const current = await lockCurrent(sql, input.groupId, input.id, input.expectedRevision);
      const postings = reversePostings(await netPostings(sql, input.id));
      const revision = current.revision + 1;

      await sql.query(
        'update transactions set revision = $2, deleted = true, updated_by = $3, updated_at = now() where id = $1',
        [input.id, revision, userId],
      );
      const deleted = { ...current, revision, deleted: true, seq };
      await appendEntry(sql, userId, { ...deleted, groupId: input.groupId, kind: 'delete', postings });
      return deleted;
    }),
  );
}

/** Every member's balance in every currency: the sum of their postings. */
export async function getBalances(pool: Pool, userId: string, groupId: string): Promise<Balances> {
  return asUser(pool, userId, async (sql) => {
    await visibleGroup(sql, groupId);
    const { rows } = await sql.query<{ member: string; currency: string; amount: string }>(
      `select member_id as member, currency, sum(amount)::text as amount from postings
       where group_id = $1 group by member_id, currency`,
      [groupId],
    );
    return balancesOf(rows.map((row) => ({ member: row.member, currency: row.currency, amount: minor(row.amount) })));
  });
}

/**
 * What changed in the group after `afterSeq`, in order. Sequence numbers have no gaps and commit in order
 * (docs/DESIGN.md §7), so a client that stores the last seq it saw and asks again never misses a change.
 */
export async function changesSince(
  pool: Pool,
  userId: string,
  groupId: string,
  afterSeq: number,
  limit = 100,
): Promise<Change[]> {
  return asUser(pool, userId, async (sql) => {
    await visibleGroup(sql, groupId);
    const { rows } = await sql.query<RevisionRow & { kind: Change['kind'] }>(
      `select e.seq::text, e.kind, e.transaction_id as id, e.group_id as "groupId", r.revision, r.deleted,
         r.description, r.occurred_on::text as "occurredOn", r.body
       from entries e join transaction_revisions r on r.entry_id = e.id
       where e.group_id = $1 and e.seq > $2 order by e.seq limit $3`,
      [groupId, afterSeq, Math.min(Math.max(limit, 1), 500)],
    );
    return rows.map((row) => ({ seq: Number(row.seq), kind: row.kind, view: fromRow(row) }));
  });
}

// ─── Inside a write ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Runs `work` once per idempotency key. The key is inserted first: a retry of a request that already committed
 * finds the row and gets the stored response back; a retry that arrives while the first attempt is still running
 * waits on the row lock, then does the same. The same key with a different request is refused.
 */
async function idempotent<T>(
  sql: Queryable,
  userId: string,
  key: string,
  request: unknown,
  work: () => Promise<T>,
): Promise<T> {
  const hash = await sha256(canonicalJson(request));
  const claimed = await sql.query(
    `insert into idempotency_keys (user_id, key, request_hash, response) values ($1, $2, $3, 'null')
     on conflict do nothing`,
    [userId, key, hash],
  );
  if (claimed.rowCount === 0) {
    const { rows } = await sql.query<{ request_hash: Buffer | Uint8Array; response: T }>(
      'select request_hash, response from idempotency_keys where user_id = $1 and key = $2',
      [userId, key],
    );
    const stored = one(rows);
    if (!equalBytes(stored.request_hash, hash)) {
      throw new StoreError('IDEMPOTENCY_MISMATCH', 'This idempotency key was already used for a different request');
    }
    return stored.response;
  }
  const response = await work();
  await sql.query('update idempotency_keys set response = $3 where user_id = $1 and key = $2', [
    userId,
    key,
    JSON.stringify(response),
  ]);
  return response;
}

/**
 * Takes the group's next sequence number. The row lock this takes is held until commit, which serialises
 * writes within one group (and only that group) and makes sequence numbers commit in order.
 * Row-level security hides groups the user is not in, so for them this finds nothing: NOT_FOUND.
 */
async function nextSeq(sql: Queryable, groupId: string): Promise<number> {
  const { rows } = await sql.query<{ seq: string }>(
    'update groups set seq = seq + 1 where id = $1 returning seq::text',
    [groupId],
  );
  if (rows.length === 0) throw new StoreError('NOT_FOUND', 'No such group');
  return Number(one(rows).seq);
}

/** The same lock as nextSeq, for writes that change the group without adding to the ledger. */
async function lockGroup(sql: Queryable, groupId: string): Promise<void> {
  const { rows } = await sql.query('select 1 from groups where id = $1 for update', [groupId]);
  if (rows.length === 0) throw new StoreError('NOT_FOUND', 'No such group');
}

async function visibleGroup(sql: Queryable, groupId: string): Promise<void> {
  const { rows } = await sql.query('select 1 from groups where id = $1', [groupId]);
  if (rows.length === 0) throw new StoreError('NOT_FOUND', 'No such group');
}

/** Runs the ledger rules and checks everyone named is an active member. Returns the postings to write. */
async function validate(sql: Queryable, groupId: string, transaction: Transaction): Promise<Posting[]> {
  const postings = toPostings(transaction);
  const { rows } = await sql.query<{ id: string }>('select id from members where group_id = $1 and left_at is null', [
    groupId,
  ]);
  const active = new Set(rows.map((row) => row.id));
  for (const member of membersNamed(transaction)) {
    if (!active.has(member)) throw new StoreError('UNKNOWN_MEMBER', `${member} is not a member of this group`);
  }
  return postings;
}

function membersNamed(transaction: Transaction): MemberId[] {
  if (transaction.kind === 'settlement') return [transaction.from, transaction.to];
  const { split } = transaction;
  const named = transaction.paidBy.map((share) => share.member);
  if (split.kind === 'equal') named.push(...split.members);
  else if (split.kind === 'exact') named.push(...split.amounts.map((share) => share.member));
  else named.push(...split.parts.map((part) => part.member));
  return named;
}

/** Locks the transaction's row and checks the client edited the current revision. */
async function lockCurrent(
  sql: Queryable,
  groupId: string,
  id: string,
  expectedRevision: number,
): Promise<TransactionView> {
  const { rows } = await sql.query<RevisionRow>(
    `select id, group_id as "groupId", revision, deleted, description, occurred_on::text as "occurredOn", body,
       (select max(seq)::text from entries where transaction_id = t.id) as seq
     from transactions t where id = $1 and group_id = $2 for update`,
    [id, groupId],
  );
  const row = rows[0];
  if (!row || row.deleted) throw new StoreError('NOT_FOUND', 'No such transaction');
  const current = fromRow(row);
  if (current.revision !== expectedRevision) {
    throw new StoreError('CONFLICT', `Changed since revision ${expectedRevision}; now at ${current.revision}`, current);
  }
  return current;
}

/**
 * What the transaction currently contributes to balances, read from the postings actually written rather than
 * recomputed from its body: if the splitting rules ever change, a reversal must still undo exactly what was
 * recorded.
 */
async function netPostings(sql: Queryable, transactionId: string): Promise<Posting[]> {
  const { rows } = await sql.query<{ member: string; currency: string; amount: string }>(
    `select p.member_id as member, p.currency, sum(p.amount)::text as amount
     from postings p join entries e on e.id = p.entry_id
     where e.transaction_id = $1
     group by p.member_id, p.currency having sum(p.amount) <> 0
     order by p.member_id, p.currency`,
    [transactionId],
  );
  return rows.map((row) => ({ member: row.member, currency: row.currency, amount: minor(row.amount) }));
}

async function appendEntry(
  sql: Queryable,
  userId: string,
  entry: {
    groupId: string;
    id: string;
    seq: number;
    kind: Change['kind'];
    revision: number;
    deleted: boolean;
    description: string;
    occurredOn: string;
    transaction: Transaction;
    postings: readonly Posting[];
  },
): Promise<void> {
  const { rows } = await sql.query<{ id: string }>(
    `insert into entries (group_id, seq, kind, transaction_id, revision, created_by)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [entry.groupId, entry.seq, entry.kind, entry.id, entry.revision, userId],
  );
  const entryId = one(rows).id;
  await sql.query(
    `insert into transaction_revisions (transaction_id, revision, entry_id, deleted, description, occurred_on, currency, body)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.id,
      entry.revision,
      entryId,
      entry.deleted,
      entry.description,
      entry.occurredOn,
      entry.transaction.currency,
      entry.transaction,
    ],
  );
  if (entry.postings.length === 0) return;
  // Amounts go over the wire as text so nothing passes through a float on the way to bigint.
  await sql.query(
    `insert into postings (entry_id, group_id, member_id, currency, amount)
     select $1, $2, member, currency, amount::bigint
     from unnest($3::uuid[], $4::text[], $5::text[]) as p (member, currency, amount)`,
    [
      entryId,
      entry.groupId,
      entry.postings.map((p) => p.member),
      entry.postings.map((p) => p.currency),
      entry.postings.map((p) => String(p.amount)),
    ],
  );
}

// ─── Rows and values ────────────────────────────────────────────────────────────────────────────────────────

interface RevisionRow {
  id: string;
  groupId: string;
  revision: number;
  deleted: boolean;
  description: string;
  occurredOn: string;
  body: Transaction;
  seq: string;
}

function fromRow(row: RevisionRow): TransactionView {
  return {
    id: row.id,
    groupId: row.groupId,
    revision: row.revision,
    deleted: row.deleted,
    description: row.description,
    occurredOn: row.occurredOn,
    transaction: row.body,
    seq: Number(row.seq),
  };
}

function view(input: RecordInput, state: { revision: number; deleted: boolean; seq: number }): TransactionView {
  return {
    id: input.id,
    groupId: input.groupId,
    revision: state.revision,
    deleted: state.deleted,
    description: input.description,
    occurredOn: input.occurredOn,
    transaction: input.transaction,
    seq: state.seq,
  };
}
