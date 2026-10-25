/**
 * What the load and crash tests share: a fresh database, the API on Node (packages/api/src/node.ts) as a child
 * process, and a small HTTP client that signs in through the development login.
 *
 * Needs a Postgres it may create and drop databases on: DATABASE_URL, default postgres://postgres@localhost:5432/postgres.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate, readMigrations } from '../../packages/db/src/migrate.ts';

export const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/postgres';
const ROLE = 'eventide_api_proof';
const PASSWORD = 'eventide_api_proof';

function urlFor(database: string, user?: string) {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user;
    url.password = PASSWORD;
  }
  return url.toString();
}

/** A new, migrated database and the API's login for it. */
export async function freshDatabase(name: string) {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  const owner = new pg.Client({ connectionString: urlFor(name) });
  await owner.connect();
  await migrate(owner, await readMigrations());
  const { rowCount } = await admin.query('select 1 from pg_roles where rolname = $1', [ROLE]);
  if (!rowCount) await admin.query(`create role ${ROLE} login password '${PASSWORD}'`);
  await admin.query(`grant eventide_app to ${ROLE}`);
  await admin.end();
  return {
    appUrl: urlFor(name, ROLE),
    owner,
    async drop() {
      await owner.end();
      const cleanup = new pg.Client({ connectionString: ADMIN_URL });
      await cleanup.connect();
      await cleanup.query(`drop database if exists ${name} with (force)`);
      await cleanup.end();
    },
  };
}

/** The API on Node, as a child process that can be stopped or killed outright. */
export async function startServer(appUrl: string, port: number, poolSize = 20) {
  let child: ChildProcess | undefined;
  const base = `http://127.0.0.1:${port}`;

  async function start() {
    child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'packages/api/src/node.ts'], {
      env: {
        ...process.env,
        DATABASE_URL: appUrl,
        PORT: String(port),
        DEV_LOGIN: 'true',
        LOG: 'errors',
        POOL_SIZE: String(poolSize),
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    for (let i = 0; i < 200; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) return;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('The server did not start');
  }

  // Never leave a server running behind a failed test.
  process.on('exit', () => child?.kill('SIGKILL'));
  await start();
  return {
    base,
    /** CPU time the server process has used so far, in milliseconds (Linux: /proc/<pid>/stat, user + system). */
    async cpuMs() {
      const { readFile } = await import('node:fs/promises');
      const fields = (await readFile(`/proc/${child?.pid}/stat`, 'utf8')).split(') ')[1]?.split(' ') ?? [];
      return ((Number(fields[11]) + Number(fields[12])) * 1000) / 100; // clock ticks, 100 per second
    },
    /** SIGKILL: no shutdown, no flushing, connections cut mid-transaction. Then start again. */
    async crashAndRestart() {
      const dying = child;
      const exited = new Promise((resolve) => dying?.once('exit', resolve));
      dying?.kill('SIGKILL');
      await exited;
      await start();
    },
    async stop() {
      const exited = new Promise((resolve) => child?.once('exit', resolve));
      child?.kill('SIGTERM');
      await exited;
    },
  };
}

/** One person using the API: their own session cookie, and the site's own Origin on every change. */
export class Person {
  cookie = '';
  readonly base: string;
  readonly name: string;

  constructor(base: string, name: string) {
    this.base = base;
    this.name = name;
  }

  async signIn() {
    const response = await fetch(`${this.base}/api/auth/dev`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: this.base },
      body: JSON.stringify({
        email: `${this.name.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`,
        name: this.name,
      }),
    });
    const cookie = response.headers.getSetCookie().find((c) => c.startsWith('__Host-session='));
    if (!cookie) throw new Error(`Sign-in failed: ${response.status}`);
    this.cookie = cookie.split(';')[0] ?? '';
    return this;
  }

  /** Returns status and body; throws only when the request never got an answer (a network error). */
  // biome-ignore lint/suspicious/noExplicitAny: test responses are inspected loosely
  async call<T = any>(
    method: string,
    path: string,
    body?: unknown,
    key?: string,
  ): Promise<{ status: number; json: T }> {
    const headers: Record<string, string> = { Cookie: this.cookie, Origin: this.base };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (key) headers['Idempotency-Key'] = key;
    const response = await fetch(`${this.base}/api${path}`, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  }
}

/** A group of people who have all joined through an invite link; returns the group id and member ids. */
export async function makeGroup(people: Person[], name: string, currency = 'GBP') {
  const [owner, ...rest] = people;
  if (!owner) throw new Error('A group needs someone');
  const created = await owner.call('POST', '/groups', { name, currency, displayName: owner.name });
  const groupId: string = created.json.group.id;
  const invite = await owner.call('POST', `/groups/${groupId}/invites`);
  for (const person of rest) {
    await person.call('POST', `/invites/${invite.json.invite.token}/accept`, { displayName: person.name });
  }
  const group = await owner.call('GET', `/groups/${groupId}`);
  const members: string[] = group.json.group.members.map((m: { id: string }) => m.id);
  return { groupId, members };
}

export function expense(members: string[], payer: string, total: number) {
  return {
    id: randomUUID(),
    description: 'Load test',
    occurredOn: '2026-10-25',
    transaction: {
      kind: 'expense',
      currency: 'GBP',
      total,
      paidBy: [{ member: payer, amount: total }],
      split: { kind: 'equal', members },
    },
  };
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}
