import pg from 'pg';
import { migrate, readMigrations } from '../src/migrate.ts';
import { ADMIN_URL, APP_LOGIN, APP_PASSWORD, TEMPLATE_DB, withDatabase } from './harness.ts';

/**
 * Once per run: a template database with every migration applied, which each test file copies (copying is far
 * faster than migrating), and the login role the tests connect as when acting as the API.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${TEMPLATE_DB} with (force)`);
    await admin.query(`create database ${TEMPLATE_DB}`);
    await withDatabase(TEMPLATE_DB, async (client) => {
      await migrate(client, await readMigrations());
    });
    const { rowCount } = await admin.query('select 1 from pg_roles where rolname = $1', [APP_LOGIN]);
    if (rowCount === 0) await admin.query(`create role ${APP_LOGIN} login password '${APP_PASSWORD}'`);
    await admin.query(`grant eventide_app to ${APP_LOGIN}`);
  } finally {
    await admin.end();
  }
  return async () => {
    const cleanup = new pg.Client({ connectionString: ADMIN_URL });
    await cleanup.connect();
    const { rows } = await cleanup.query<{ datname: string }>(
      "select datname from pg_database where datname like 'eventide_test_%' or datname = $1",
      [TEMPLATE_DB],
    );
    for (const { datname } of rows) await cleanup.query(`drop database if exists ${datname} with (force)`);
    await cleanup.end();
  };
}
