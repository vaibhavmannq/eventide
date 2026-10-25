import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

export const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url).pathname;

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export async function readMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const migrations: Migration[] = [];
  for (const file of (await readdir(dir)).sort()) {
    const match = FILE.exec(file);
    if (!match) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    migrations.push({
      version: Number(match[1]),
      name: match[2] ?? '',
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new Error(`Migration ${migration.version} is out of sequence`);
  });
  return migrations;
}

/**
 * Applies the migrations that have not run yet, each in its own transaction, so a failure leaves the database
 * at the last good version. An advisory lock stops two deploys migrating at once. A migration that already ran
 * must never change: if its checksum differs from the one recorded, nothing runs and the error says which.
 *
 * Runs as the database owner, never as the API's role.
 */
export async function migrate(client: pg.ClientBase, migrations: readonly Migration[]): Promise<number[]> {
  await client.query('select pg_advisory_lock(hashtext($1))', ['eventide.migrate']);
  try {
    await client.query(`
      create table if not exists schema_migrations (
        version    integer primary key,
        name       text not null,
        checksum   text not null,
        applied_at timestamptz not null default now()
      )`);
    const { rows } = await client.query<{ version: number; checksum: string }>(
      'select version, checksum from schema_migrations order by version',
    );
    const applied = new Map(rows.map((row) => [row.version, row.checksum]));

    for (const [version, checksum] of applied) {
      const migration = migrations.find((m) => m.version === version);
      if (!migration) throw new Error(`Migration ${version} was applied but no longer exists`);
      if (migration.checksum !== checksum) {
        throw new Error(`Migration ${version}_${migration.name} was changed after it ran; add a new one instead`);
      }
    }

    const ran: number[] = [];
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      await client.query('begin');
      try {
        await client.query(migration.sql);
        await client.query('insert into schema_migrations (version, name, checksum) values ($1, $2, $3)', [
          migration.version,
          migration.name,
          migration.checksum,
        ]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw new Error(`Migration ${migration.version}_${migration.name} failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
      ran.push(migration.version);
    }
    return ran;
  } finally {
    await client.query('select pg_advisory_unlock(hashtext($1))', ['eventide.migrate']);
  }
}
