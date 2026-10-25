import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, recordTransaction } from '../src/index.ts';
import { dinner, type Fixture, newIds, seed } from './fixtures.ts';
import { createTestDatabase, type TestDatabase } from './harness.ts';

/**
 * The rules the database enforces by itself, tested by going around the store and writing SQL directly:
 * these are what still hold if the API has a bug.
 */
let db: TestDatabase;
let f: Fixture;

beforeAll(async () => {
  db = await createTestDatabase();
  f = await seed(db);
});
afterAll(() => db.close());

/** Writes an entry with the given postings straight into the tables, as the owner, in one transaction. */
async function writeEntry(amounts: { member: string; amount: number; currency?: string }[]) {
  const client = await db.owner.connect();
  try {
    await client.query('begin');
    const transactionId = randomUUID();
    const { rows } = await client.query<{ seq: string }>(
      'update groups set seq = seq + 1 where id = $1 returning seq',
      [f.groupId],
    );
    await client.query(
      `insert into transactions (id, group_id, kind, revision, occurred_on, currency, body, created_by, updated_by)
       values ($1, $2, 'expense', 1, '2026-10-25', 'GBP', '{}', $3, $3)`,
      [transactionId, f.groupId, f.alice],
    );
    const entry = await client.query<{ id: string }>(
      `insert into entries (group_id, seq, kind, transaction_id, revision, created_by)
       values ($1, $2, 'create', $3, 1, $4) returning id`,
      [f.groupId, rows[0]?.seq, transactionId, f.alice],
    );
    for (const { member, amount, currency = 'GBP' } of amounts) {
      await client.query(
        'insert into postings (entry_id, group_id, member_id, currency, amount) values ($1, $2, $3, $4, $5)',
        [entry.rows[0]?.id, f.groupId, member, currency, amount],
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

describe('double-entry, enforced by Postgres', () => {
  it('commits postings that add up to zero', async () => {
    await expect(
      writeEntry([
        { member: f.members.alice, amount: 500 },
        { member: f.members.bob, amount: -500 },
      ]),
    ).resolves.toBeUndefined();
  });

  it('refuses to commit postings that do not, even for the owner', async () => {
    await expect(
      writeEntry([
        { member: f.members.alice, amount: 500 },
        { member: f.members.bob, amount: -499 },
      ]),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('does not balance') });
  });

  it('checks each currency on its own', async () => {
    await expect(
      writeEntry([
        { member: f.members.alice, amount: 500, currency: 'GBP' },
        { member: f.members.bob, amount: -500, currency: 'EUR' },
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a posting for someone from another group', async () => {
    const other = await db.owner.query<{ id: string }>(
      `with g as (insert into groups (name, default_currency, created_by) values ('Other', 'GBP', $1) returning id)
       insert into members (group_id, display_name) select id, 'Stranger' from g returning id`,
      [f.mallory],
    );
    await expect(
      writeEntry([
        { member: f.members.alice, amount: 500 },
        { member: other.rows[0]?.id ?? '', amount: -500 },
      ]),
    ).rejects.toMatchObject({ code: '23503' }); // foreign_key_violation
  });
});

describe('append-only, enforced by Postgres', () => {
  const columns = { postings: 'amount', entries: 'kind', transaction_revisions: 'revision' };
  for (const [table, column] of Object.entries(columns)) {
    it(`stops even the owner updating, deleting or truncating ${table}`, async () => {
      await expect(db.owner.query(`update ${table} set ${column} = ${column}`)).rejects.toThrow(/append-only/);
      await expect(db.owner.query(`delete from ${table}`)).rejects.toThrow(/append-only/);
      await expect(db.owner.query(`truncate ${table} cascade`)).rejects.toThrow(/append-only/);
    });
  }

  it("does not give the API's role the privilege to try", async () => {
    await expect(db.app.query('delete from postings')).rejects.toMatchObject({ code: '42501' });
    await expect(db.app.query('update postings set amount = 0')).rejects.toMatchObject({ code: '42501' });
  });
});

describe('row-level security', () => {
  const count = (userId: string | null, table: string) =>
    asUser(db.app, userId ?? '', async (sql) => {
      const { rows } = await sql.query<{ n: string }>(`select count(*)::text as n from ${table}`);
      return Number(rows[0]?.n);
    });

  beforeAll(async () => {
    await recordTransaction(db.app, f.alice, {
      groupId: f.groupId,
      ...newIds(),
      description: 'Dinner',
      occurredOn: '2026-10-25',
      transaction: dinner(f.members),
    });
  });

  it('shows members their group', async () => {
    expect(await count(f.alice, 'groups')).toBe(1);
    expect(await count(f.bob, 'postings')).toBeGreaterThan(0);
  });

  it('shows everyone else nothing', async () => {
    for (const table of ['groups', 'members', 'transactions', 'entries', 'transaction_revisions', 'postings']) {
      expect(await count(f.mallory, table), table).toBe(0);
      expect(await count(null, table), `${table} with no user`).toBe(0);
    }
  });

  it('refuses writes into a group you are not in, even with the right ids', async () => {
    await expect(
      asUser(db.app, f.mallory, (sql) =>
        sql.query(`insert into members (group_id, display_name) values ($1, 'Mallory')`, [f.groupId]),
      ),
    ).rejects.toMatchObject({ code: '42501' }); // new row violates row-level security policy
  });

  it('refuses to create a group with nobody signed in', async () => {
    await expect(asUser(db.app, '', (sql) => sql.query(`select create_group('x', 'GBP', 'x')`))).rejects.toMatchObject({
      code: '28000',
    });
  });
});
