import { randomUUID } from 'node:crypto';
import pg from 'pg';

/** A Postgres the tests may create and drop databases on. Never point this at production. */
export const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/postgres';
export const TEMPLATE_DB = 'eventide_template';
export const APP_LOGIN = 'eventide_api_test';
export const APP_PASSWORD = 'eventide_api_test';

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

export async function withDatabase<T>(database: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: urlFor(database) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export interface TestDatabase {
  name: string;
  /** Connected as the database owner: migrations, and checks that even the owner is stopped. */
  owner: pg.Pool;
  /** Connected as the API's role: what production code gets. */
  app: pg.Pool;
  close(): Promise<void>;
}

/** A fresh database for one test file, copied from the migrated template. */
export async function createTestDatabase(options: { migrated?: boolean } = {}): Promise<TestDatabase> {
  const name = `eventide_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(
      options.migrated === false ? `create database ${name}` : `create database ${name} template ${TEMPLATE_DB}`,
    );
  } finally {
    await admin.end();
  }
  const owner = new pg.Pool({ connectionString: urlFor(name), max: 5 });
  const app = new pg.Pool({
    connectionString: urlFor(name, { name: APP_LOGIN, password: APP_PASSWORD }),
    max: 20,
  });
  return {
    name,
    owner,
    app,
    async close() {
      await Promise.all([owner.end(), app.end()]);
      const cleanup = new pg.Client({ connectionString: ADMIN_URL });
      await cleanup.connect();
      await cleanup.query(`drop database if exists ${name} with (force)`);
      await cleanup.end();
    },
  };
}
