/**
 * The same API on plain Node.js, with no Cloudflare: one file instead of worker.ts (ADR 0005, "Moving off
 * Cloudflare"). Used by the load and crash tests in scripts/, and the way to self-host.
 *
 *   DATABASE_URL=postgres://eventide_api:…@host/db PORT=8790 node --experimental-strip-types packages/api/src/node.ts
 */
import { serve } from '@hono/node-server';
import pg from 'pg';
import { app } from './app.ts';
import type { Config } from './config.ts';
import { github, google } from './config.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL to the API role connection string.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: Number(process.env.POOL_SIZE ?? 20) });
pool.on('error', (error) => console.error(JSON.stringify({ level: 'error', event: 'pool', error: String(error) })));

const providers: Config['providers'] = {};
const env = process.env;
if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)
  providers.github = github(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET);
if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
  providers.google = google(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);

const quiet = env.LOG === 'errors';
const config: Config = {
  providers,
  signups: {
    open: env.SIGNUPS !== 'invite',
    allowedEmails: (env.ALLOWED_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  },
  devLogin: env.DEV_LOGIN === 'true',
  fetch: (input, init) => fetch(input, init),
  log: (entry) => {
    if (!quiet || entry.level === 'error') console.log(JSON.stringify(entry));
  },
};

const port = Number(env.PORT ?? 8790);
serve({ fetch: (request) => app.fetch(request, { db: pool, config }), port, hostname: '127.0.0.1' }, () =>
  console.log(JSON.stringify({ event: 'listening', port })),
);
