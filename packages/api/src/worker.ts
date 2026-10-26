/**
 * The Cloudflare Worker. Requests under /api reach the API; every other path is served from the app's files
 * (wrangler.jsonc, `assets`), so the app and the API share one origin and the session cookie is first-party.
 */
import { nightly } from '@eventide/db';
import pg from 'pg';
import { app } from './app.ts';
import { assetLinks } from './assetlinks.ts';
import { type Config, github, google } from './config.ts';

interface Env {
  /** Cloudflare Hyperdrive: pooled connections to Neon, kept warm near the database. */
  HYPERDRIVE: { connectionString: string };
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** "true" only in .dev.vars for local development. Never set it in production. */
  DEV_LOGIN?: string;
  /** "open" lets anyone create an account; anything else (the default) means invite-only. */
  SIGNUPS?: string;
  /** Comma-separated emails that may create an account without an invite (yours, at least). */
  ALLOWED_EMAILS?: string;
  /**
   * "off" only for local development and CI: `wrangler dev` sees every test browser as the same address, so a fast
   * test run would spend the per-IP budget meant for one person. Production never sets it.
   */
  RATE_LIMITS?: string;
  /**
   * The Android app's signing key, as keytool prints its SHA-256 fingerprint (AA:BB:…), comma-separated if more
   * than one. Public, so it lives in wrangler.jsonc. Until it is set the app still works, with an address bar.
   */
  ANDROID_CERT_SHA256?: string;
  /** Cloudflare's rate limiting bindings (wrangler.jsonc, `ratelimits`). */
  RL_IP?: RateLimit;
  RL_USER?: RateLimit;
}

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

function configFrom(env: Env): Config {
  const providers: Config['providers'] = {};
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    providers.github = github(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET);
  }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.google = google(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  }
  return {
    providers,
    signups: {
      open: env.SIGNUPS === 'open',
      allowedEmails: (env.ALLOWED_EMAILS ?? '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    },
    limit:
      env.RATE_LIMITS === 'off'
        ? undefined
        : async (bucket, key) => {
            const binding = bucket === 'ip' ? env.RL_IP : env.RL_USER;
            return binding ? (await binding.limit({ key })).success : true;
          },
    devLogin: env.DEV_LOGIN === 'true',
    fetch: (input, init) => fetch(input, init),
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

/**
 * A pool per request, as Hyperdrive recommends: Hyperdrive does the real pooling, and Workers share nothing.
 * Closing it after the response makes the Workers runtime report each closed socket as an error; those are
 * expected and dropped, so the log only shows errors that happened while the request was being served.
 */
function poolFor(env: Env) {
  const pool = new pg.Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 5 });
  let closing = false;
  pool.on('error', (error) => {
    if (!closing) console.error(JSON.stringify({ level: 'error', event: 'pool', error: String(error) }));
  });
  return {
    pool,
    close: () => {
      closing = true;
      return pool.end();
    },
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === '/.well-known/assetlinks.json') {
      return assetLinks(env.ANDROID_CERT_SHA256) ?? new Response('Not found', { status: 404 });
    }
    const { pool, close } = poolFor(env);
    try {
      return await app.fetch(request, { db: pool, config: configFrom(env) }, ctx as never);
    } finally {
      ctx.waitUntil(close());
    }
  },

  /** Nightly (wrangler.jsonc, `triggers`): audit every ledger, purge expired sessions, invites and keys. */
  async scheduled(_controller: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    const { pool, close } = poolFor(env);
    try {
      const result = await nightly(pool);
      const level = result.unbalanced.length > 0 ? 'error' : 'info';
      console.log(JSON.stringify({ level, event: 'nightly', ...result }));
    } finally {
      ctx.waitUntil(close());
    }
  },
};
