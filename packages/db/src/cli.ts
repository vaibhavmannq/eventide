/**
 * Applies pending migrations to DATABASE_URL, connecting as the database owner.
 * Run: npm run db:migrate
 */
import pg from 'pg';
import { migrate, readMigrations } from './migrate.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL to the database owner connection string.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const ran = await migrate(client, await readMigrations());
  console.log(ran.length ? `Applied migrations: ${ran.join(', ')}` : 'Already up to date.');
} finally {
  await client.end();
}
