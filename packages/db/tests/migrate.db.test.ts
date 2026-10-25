import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Migration, migrate, readMigrations } from '../src/migrate.ts';
import { createTestDatabase, type TestDatabase } from './harness.ts';

let db: TestDatabase;

beforeEach(async () => {
  db = await createTestDatabase({ migrated: false });
});
afterEach(() => db.close());

const run = async (migrations: readonly Migration[]) => {
  const client = await db.owner.connect();
  try {
    return await migrate(client, migrations);
  } finally {
    client.release();
  }
};

describe('migrate', () => {
  it('applies every migration to an empty database, then nothing the second time', async () => {
    const migrations = await readMigrations();
    expect(await run(migrations)).toEqual(migrations.map((m) => m.version));
    expect(await run(migrations)).toEqual([]);
  });

  it('refuses to run when a migration that already ran has been edited', async () => {
    const migrations = await readMigrations();
    await run(migrations);
    const edited = migrations.map((m, i) => (i === 0 ? { ...m, checksum: 'edited' } : m));
    await expect(run(edited)).rejects.toThrow(/was changed after it ran/);
  });

  it('rolls a failed migration back completely and records nothing', async () => {
    const migrations = await readMigrations();
    await run(migrations);
    const broken: Migration = {
      version: migrations.length + 1,
      name: 'broken',
      sql: 'create table half_done (id int); select 1 / 0;',
      checksum: 'x',
    };
    await expect(run([...migrations, broken])).rejects.toThrow(/broken failed: division by zero/);
    const { rows } = await db.owner.query(
      "select to_regclass('half_done') as t, max(version) as v from schema_migrations",
    );
    expect(rows[0]).toEqual({ t: null, v: migrations.length });
  });

  it('0004 fills in group_id on revisions written before it, through the append-only rule', async () => {
    const all = await readMigrations();
    await run(all.slice(0, 3));
    await db.owner.query(`
      with u as (insert into users (email, name) values ('a@example.com', 'A') returning id),
           g as (insert into groups (name, default_currency, created_by) select 'G', 'GBP', id from u returning id, created_by),
           t as (insert into transactions (id, group_id, kind, revision, occurred_on, currency, body, created_by, updated_by)
                 select gen_random_uuid(), g.id, 'expense', 1, '2026-10-25', 'GBP', '{}', g.created_by, g.created_by from g
                 returning id, group_id, created_by),
           e as (insert into entries (group_id, seq, kind, transaction_id, revision, created_by)
                 select group_id, 1, 'create', id, 1, created_by from t returning id, transaction_id)
      insert into transaction_revisions (transaction_id, revision, entry_id, deleted, description, occurred_on, currency, body)
      select transaction_id, 1, id, false, '', '2026-10-25', 'GBP', '{}' from e`);
    await run(all);
    const { rows } = await db.owner.query(
      'select count(*)::int as n from transaction_revisions r join transactions t on t.id = r.transaction_id where r.group_id = t.group_id',
    );
    expect(rows[0]).toEqual({ n: 1 });
    // And the table is append-only again afterwards.
    await expect(db.owner.query('update transaction_revisions set revision = revision')).rejects.toThrow(/append-only/);
  });

  it('reads migrations in order and refuses a gap in the numbering', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'migrations-'));
    await writeFile(join(dir, '0001_a.sql'), 'select 1;');
    await writeFile(join(dir, '0003_c.sql'), 'select 1;');
    await expect(readMigrations(dir)).rejects.toThrow(/out of sequence/);
  });
});
