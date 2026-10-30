import { randomUUID } from 'node:crypto';
import { LIMITS } from '@eventide/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/tests/harness.ts';
import { app } from '../src/app.ts';
import { type Config, google, type OAuthProvider } from '../src/config.ts';

/**
 * The API end to end: real requests through every middleware, the ledger and the store, against Postgres.
 * Only GitHub and Google are stood in for.
 */
const ORIGIN = 'https://eventide.test';
let db: TestDatabase;
const logs: Record<string, unknown>[] = [];

const config = (overrides: Partial<Config> = {}): Config => ({
  providers: {},
  signups: { open: true, allowedEmails: [] },
  devLogin: true,
  fetch: () => Promise.reject(new Error('no network in tests')),
  log: (entry) => logs.push(entry),
  ...overrides,
});

interface Call {
  body?: unknown;
  cookie?: string;
  key?: string;
  origin?: string | null;
  config?: Config;
}

async function call(method: string, path: string, options: Call = {}) {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.key) headers['Idempotency-Key'] = options.key;
  if (options.origin !== null) headers.Origin = options.origin ?? ORIGIN;
  const response = await app.request(
    `${ORIGIN}/api${path}`,
    { method, headers, body: options.body === undefined ? null : JSON.stringify(options.body) },
    { db: db.app, config: options.config ?? config() },
  );
  const text = await response.text();
  // biome-ignore lint/suspicious/noExplicitAny: test responses are inspected loosely
  const json: any = text ? JSON.parse(text) : null;
  return { status: response.status, json, text, headers: response.headers };
}

/** Signs in through the development login and returns the session cookie to send back. */
async function signIn(email: string, name: string): Promise<string> {
  const response = await call('POST', '/auth/dev', { body: { email, name } });
  expect(response.status).toBe(200);
  return cookieFrom(response.headers);
}

function cookieFrom(headers: Headers, name = '__Host-session'): string {
  const cookie = headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  if (!cookie) throw new Error(`No ${name} cookie`);
  return cookie.split(';')[0] ?? '';
}

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(() => db.close());

describe('the basics', () => {
  it('answers health checks without signing in, having reached the database', async () => {
    expect(await call('GET', '/health')).toMatchObject({ status: 200, json: { ok: true, database: { ok: true } } });
  });

  it('fails the health check when the database cannot be reached', async () => {
    const broken = { connect: () => Promise.reject(new Error('no route to host')) };
    const response = await app.request(`${ORIGIN}/api/health`, {}, { db: broken, config: config() });
    expect(response.status).toBe(500);
  });

  it('asks for sign-in, in the standard error shape', async () => {
    expect(await call('GET', '/me')).toMatchObject({
      status: 401,
      json: { error: { code: 'UNAUTHENTICATED', message: 'Sign in first' } },
    });
  });

  it('sets a session cookie that only HTTPS, this host and no script can use', async () => {
    const response = await call('POST', '/auth/dev', { body: { email: 'cookie@example.com', name: 'C' } });
    const cookie = response.headers.getSetCookie().find((c) => c.startsWith('__Host-session=')) ?? '';
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; SameSite=Lax/);
    expect(cookie).not.toMatch(/Domain=/);
  });

  it('tells the app which sign-in buttons to show', async () => {
    expect((await call('GET', '/auth/providers')).json).toEqual({ github: false, google: false, dev: true });
  });

  it('turns the development login off unless it is configured on', async () => {
    const off = await call('POST', '/auth/dev', {
      body: { email: 'x@example.com', name: 'X' },
      config: config({ devLogin: false }),
    });
    expect(off.status).toBe(404);
  });

  it('refuses changes from another site, or with no Origin', async () => {
    const cookie = await signIn('csrf@example.com', 'C');
    const body = { name: 'G', currency: 'GBP', displayName: 'C' };
    expect((await call('POST', '/groups', { body, cookie, origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('POST', '/groups', { body, cookie, origin: null })).json.error.code).toBe('BAD_ORIGIN');
    expect((await call('POST', '/groups', { body, cookie })).status).toBe(201);
  });

  it('signs out, and the old cookie stops working', async () => {
    const cookie = await signIn('leaver@example.com', 'L');
    expect((await call('GET', '/me', { cookie })).status).toBe(200);
    expect((await call('POST', '/auth/logout', { cookie })).status).toBe(204);
    expect((await call('GET', '/me', { cookie })).status).toBe(401);
  });

  it('hides internal errors, and logs them', async () => {
    const cookie = await signIn('boom@example.com', 'B');
    const broken = { connect: () => Promise.reject(new Error('database is on fire')) };
    const failing = await app.request(
      `${ORIGIN}/api/groups`,
      { headers: { Cookie: cookie } },
      { db: broken, config: config() },
    );
    expect(failing.status).toBe(500);
    expect(await failing.json()).toEqual({ error: { code: 'INTERNAL', message: 'Something went wrong on our side' } });
    expect(logs.some((entry) => String(entry.error).includes('database is on fire'))).toBe(true);
  });
});

describe('a flat sharing costs', () => {
  let alice: string;
  let bob: string;
  let groupId: string;
  const member = { alice: '', bob: '', sam: '' };

  beforeAll(async () => {
    alice = await signIn('alice@example.com', 'Alice');
    bob = await signIn('bob@example.com', 'Bob');
  });

  it('creates a group, adds Sam by name, and invites Bob', async () => {
    const created = await call('POST', '/groups', {
      cookie: alice,
      body: { name: 'Flat 4', currency: 'GBP', displayName: 'Alice' },
    });
    expect(created.status).toBe(201);
    groupId = created.json.group.id;
    member.alice = created.json.group.members[0].id;

    const sam = await call('POST', `/groups/${groupId}/members`, { cookie: alice, body: { displayName: 'Sam' } });
    member.sam = sam.json.member.id;

    const invite = await call('POST', `/groups/${groupId}/invites`, { cookie: alice });
    expect(invite.json.invite.url).toMatch(new RegExp(`^${ORIGIN}/join/`));
    const token = invite.json.invite.token;

    const preview = await call('GET', `/invites/${token}`, { cookie: bob });
    expect(preview.json.invite).toMatchObject({ groupName: 'Flat 4', unclaimed: [{ displayName: 'Sam' }] });

    expect(
      (await call('POST', `/invites/${token}/accept`, { cookie: bob, body: { displayName: 'Bob' } })).json,
    ).toEqual({ groupId });
    const group = await call('GET', `/groups/${groupId}`, { cookie: bob });
    member.bob = group.json.group.members.find((m: { displayName: string }) => m.displayName === 'Bob').id;
    expect((await call('GET', '/groups', { cookie: bob })).json.groups).toHaveLength(1);
  });

  it('refuses an amount beyond a trillion minor units', async () => {
    const body = (total: number) => ({
      id: randomUUID(),
      description: 'Absurd',
      occurredOn: '2026-10-25',
      transaction: {
        kind: 'expense',
        currency: 'GBP',
        total,
        paidBy: [{ member: member.alice, amount: total }],
        split: { kind: 'equal', members: [member.alice, member.bob] },
      },
    });
    const tooMuch = await call('POST', `/groups/${groupId}/transactions`, {
      cookie: alice,
      key: randomUUID(),
      body: body(1_000_000_000_001),
    });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.json.error.code).toBe('INVALID_REQUEST');
  });

  it('says plainly when a limit is reached: 403, not a retryable error', async () => {
    let last = { status: 0, json: null as { error: { code: string; message: string } } | null };
    for (let n = 0; n <= LIMITS.openInvitesPerGroup; n++) {
      last = await call('POST', `/groups/${groupId}/invites`, { cookie: alice });
    }
    expect(last.status).toBe(403);
    expect(last.json?.error.code).toBe('LIMIT_REACHED');
    expect(last.json?.error.message).toMatch(/invite links that still work/);
  });

  it('records an expense once, however many times it is sent', async () => {
    const key = randomUUID();
    const body = {
      id: randomUUID(),
      description: 'Groceries',
      occurredOn: '2026-10-25',
      transaction: {
        kind: 'expense',
        currency: 'GBP',
        total: 9000,
        paidBy: [{ member: member.alice, amount: 9000 }],
        split: { kind: 'equal', members: [member.alice, member.bob, member.sam] },
      },
    };
    const first = await call('POST', `/groups/${groupId}/transactions`, { cookie: alice, key, body });
    const again = await call('POST', `/groups/${groupId}/transactions`, { cookie: alice, key, body });
    expect(first.status).toBe(201);
    expect(again.text).toBe(first.text); // byte for byte, not just the same data

    const balances = await call('GET', `/groups/${groupId}/balances`, { cookie: bob });
    expect(balances.json.currencies.GBP.balances).toEqual({
      [member.alice]: 6000,
      [member.bob]: -3000,
      [member.sam]: -3000,
    });
    expect(balances.json.currencies.GBP.settleUp).toHaveLength(2);
  });

  it('settles up with the suggested payments, and everyone is even', async () => {
    const { json } = await call('GET', `/groups/${groupId}/balances`, { cookie: bob });
    for (const { from, to, amount } of json.currencies.GBP.settleUp) {
      const paid = await call('POST', `/groups/${groupId}/transactions`, {
        cookie: bob,
        key: randomUUID(),
        body: {
          id: randomUUID(),
          occurredOn: '2026-10-26',
          transaction: { kind: 'settlement', currency: 'GBP', from, to, amount },
        },
      });
      expect(paid.status).toBe(201);
    }
    expect((await call('GET', `/groups/${groupId}/balances`, { cookie: alice })).json).toEqual({ currencies: {} });
  });

  it('refuses an edit of a stale version with 409 and the current version', async () => {
    const created = await call('POST', `/groups/${groupId}/transactions`, {
      cookie: alice,
      key: randomUUID(),
      body: {
        id: randomUUID(),
        description: 'Pizza',
        occurredOn: '2026-10-27',
        transaction: {
          kind: 'expense',
          currency: 'GBP',
          total: 3000,
          paidBy: [{ member: member.bob, amount: 3000 }],
          split: { kind: 'equal', members: [member.alice, member.bob] },
        },
      },
    });
    const t = created.json.transaction;
    const edit = (cookie: string, total: number) =>
      call('PUT', `/groups/${groupId}/transactions/${t.id}`, {
        cookie,
        key: randomUUID(),
        body: {
          expectedRevision: 1,
          description: 'Pizza',
          occurredOn: '2026-10-27',
          transaction: { ...t.transaction, total, paidBy: [{ member: member.bob, amount: total }] },
        },
      });
    expect((await edit(alice, 3200)).status).toBe(200);
    const stale = await edit(bob, 2800);
    expect(stale.status).toBe(409);
    expect(stale.json.error).toMatchObject({ code: 'CONFLICT', details: { revision: 2, id: t.id } });

    const deleted = await call('DELETE', `/groups/${groupId}/transactions/${t.id}?revision=2`, {
      cookie: bob,
      key: randomUUID(),
    });
    expect(deleted.json.transaction).toMatchObject({ deleted: true, revision: 3 });
    expect((await call('GET', `/groups/${groupId}/balances`, { cookie: alice })).json).toEqual({ currencies: {} });
  });

  it('serves the change feed in order, from any point', async () => {
    const all = await call('GET', `/groups/${groupId}/changes`, { cookie: bob });
    const kinds = all.json.changes.map((c: { kind: string }) => c.kind);
    expect(kinds).toEqual(['create', 'create', 'create', 'create', 'edit', 'delete']);
    const rest = await call('GET', `/groups/${groupId}/changes?after=4`, { cookie: bob });
    expect(rest.json.changes.map((c: { seq: number }) => c.seq)).toEqual([5, 6]);
    expect(rest.json.lastSeq).toBe(6);
  });

  it('explains what is wrong with a bad request', async () => {
    const post = (body: unknown, key: string | null = randomUUID()) =>
      call('POST', `/groups/${groupId}/transactions`, key ? { cookie: alice, key, body } : { cookie: alice, body });
    const valid = {
      id: randomUUID(),
      occurredOn: '2026-10-25',
      transaction: {
        kind: 'expense',
        currency: 'GBP',
        total: 100,
        paidBy: [{ member: member.alice, amount: 100 }],
        split: { kind: 'equal', members: [member.alice] },
      },
    };

    expect((await post(valid, null)).json.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const shape = await post({ ...valid, occurredOn: 'yesterday', extra: 1 });
    expect(shape.status).toBe(400);
    expect(shape.json.error.code).toBe('INVALID_REQUEST');
    expect(shape.json.error.details.map((d: { path: string }) => d.path)).toEqual(
      expect.arrayContaining(['occurredOn']),
    );

    const money = await post({ ...valid, transaction: { ...valid.transaction, total: 101 } });
    expect(money).toMatchObject({ status: 422, json: { error: { code: 'PAYERS_MISMATCH' } } });

    const stranger = await post({
      ...valid,
      transaction: { ...valid.transaction, split: { kind: 'equal', members: [randomUUID()] } },
    });
    expect(stranger).toMatchObject({ status: 422, json: { error: { code: 'UNKNOWN_MEMBER' } } });
  });

  it('refuses leaving while money is owed, with 409 and a reason', async () => {
    const sam = await call('POST', `/groups/${groupId}/members`, { cookie: alice, body: { displayName: 'Pat' } });
    expect((await call('DELETE', `/groups/${groupId}/members/${sam.json.member.id}`, { cookie: bob })).status).toBe(
      204,
    );
    const owing = await call('POST', `/groups/${groupId}/transactions`, {
      cookie: alice,
      key: randomUUID(),
      body: {
        id: randomUUID(),
        occurredOn: '2026-10-28',
        transaction: {
          kind: 'expense',
          currency: 'GBP',
          total: 1000,
          paidBy: [{ member: member.alice, amount: 1000 }],
          split: { kind: 'equal', members: [member.alice, member.bob] },
        },
      },
    });
    expect(owing.status).toBe(201);
    const leave = await call('POST', `/groups/${groupId}/leave`, { cookie: bob });
    expect(leave).toMatchObject({ status: 409, json: { error: { code: 'NOT_SETTLED' } } });
    expect((await call('DELETE', `/groups/${groupId}`, { cookie: bob })).status).toBe(403);
  });

  it('shows outsiders nothing, not even whether the group exists', async () => {
    const mallory = await signIn('mallory@example.com', 'Mallory');
    for (const path of [`/groups/${groupId}`, `/groups/${groupId}/balances`, `/groups/${groupId}/changes`]) {
      expect((await call('GET', path, { cookie: mallory })).status, path).toBe(404);
    }
    expect((await call('GET', `/groups/${randomUUID()}`, { cookie: mallory })).status).toBe(404);
    expect((await call('GET', '/groups/not-a-uuid', { cookie: mallory })).status).toBe(400);
  });
});

describe('sign in with a provider', () => {
  /** A stand-in for GitHub: hands out a token for the code "good", and a profile for that token. */
  const fake = (email: { address: string; verified: boolean } | null): OAuthProvider => ({
    clientId: 'client',
    clientSecret: 'secret',
    authorizeUrl: 'https://provider.test/authorize',
    tokenUrl: 'https://provider.test/token',
    scope: 'email',
    profile: async (token) =>
      token === 'access-token' && email?.verified ? { email: email.address, name: 'Grace' } : null,
  });
  const providerFetch: typeof fetch = async (input, init) => {
    const body = new URLSearchParams(String(init?.body));
    const ok =
      String(input) === 'https://provider.test/token' && body.get('code') === 'good' && body.get('code_verifier');
    return Response.json(ok ? { access_token: 'access-token' } : { error: 'bad_verification_code' });
  };
  const withProvider = (email: { address: string; verified: boolean } | null) =>
    config({ devLogin: false, providers: { github: fake(email) }, fetch: providerFetch });

  async function start(cfg: Config, next = '/groups') {
    const response = await call('GET', `/auth/github?next=${encodeURIComponent(next)}`, { config: cfg });
    const location = new URL(response.headers.get('Location') ?? '');
    return { response, location, cookie: cookieFrom(response.headers, '__Host-oauth') };
  }

  it('sends the browser to the provider with a state and a PKCE challenge', async () => {
    const { response, location } = await start(withProvider(null));
    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe('https://provider.test/authorize');
    expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/github/callback`);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('state')).toBeTruthy();
  });

  it('signs in with a verified email and returns to where the person was going', async () => {
    const cfg = withProvider({ address: 'Grace@Example.com', verified: true });
    const { location, cookie } = await start(cfg, '/groups/abc');
    const state = location.searchParams.get('state');
    const callback = await call('GET', `/auth/github/callback?code=good&state=${state}`, { cookie, config: cfg });
    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).toBe('/groups/abc');
    const me = await call('GET', '/me', { cookie: cookieFrom(callback.headers) });
    expect(me.json.user).toMatchObject({ email: 'grace@example.com', name: 'Grace' });
  });

  it('refuses a callback whose state does not match this browser', async () => {
    const cfg = withProvider({ address: 'grace@example.com', verified: true });
    const { cookie } = await start(cfg);
    const callback = await call('GET', '/auth/github/callback?code=good&state=forged', { cookie, config: cfg });
    expect(callback.headers.get('Location')).toBe('/?signin=failed');
    expect(callback.headers.getSetCookie().some((c) => c.startsWith('__Host-session='))).toBe(false);
  });

  it('refuses an unverified email', async () => {
    const cfg = withProvider({ address: 'eve@example.com', verified: false });
    const { location, cookie } = await start(cfg);
    const state = location.searchParams.get('state');
    const callback = await call('GET', `/auth/github/callback?code=good&state=${state}`, { cookie, config: cfg });
    expect(callback.headers.get('Location')).toBe('/?signin=failed');
  });

  it('never redirects off-site after signing in', async () => {
    const cfg = withProvider({ address: 'grace@example.com', verified: true });
    for (const next of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
      const { location, cookie } = await start(cfg, next);
      const state = location.searchParams.get('state');
      const callback = await call('GET', `/auth/github/callback?code=good&state=${state}`, { cookie, config: cfg });
      expect(callback.headers.get('Location'), next).toBe('/');
    }
  });

  describe('for the desktop and Android apps', () => {
    const APP_UA = 'Mozilla/5.0 (Windows NT 10.0) Edg/130.0 EventideDesktop/0.1.0';
    const b64url = (bytes: ArrayBuffer) => Buffer.from(bytes).toString('base64url');
    const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    const challengeFor = async (v: string) =>
      b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));

    async function browserSignIn(cfg: Config, challenge: string) {
      const begin = await call('GET', `/auth/github?next=%2Fgroups&handoff=${challenge}`, { config: cfg });
      const state = new URL(begin.headers.get('Location') ?? '').searchParams.get('state');
      const callback = await call('GET', `/auth/github/callback?code=good&state=${state}`, {
        cookie: cookieFrom(begin.headers, '__Host-oauth'),
        config: cfg,
      });
      const location = callback.headers.get('Location') ?? '';
      return { callback, code: /^\/desktop-return#code=([\w-]{43})$/.exec(location)?.[1] };
    }

    const exchange = (body: unknown, userAgent = APP_UA) =>
      app.request(
        `${ORIGIN}/api/auth/handoff`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'User-Agent': userAgent },
          body: JSON.stringify(body),
        },
        { db: db.app, config: config() },
      );

    it('gives the browser no session, and the app a code it can swap once, with its verifier', async () => {
      const cfg = withProvider({ address: 'ada@example.com', verified: true });
      const { callback, code } = await browserSignIn(cfg, await challengeFor(verifier));
      expect(code).toBeTruthy();
      expect(callback.headers.getSetCookie().some((c) => c.startsWith('__Host-session='))).toBe(false);

      const swapped = await exchange({ code, verifier });
      expect(swapped.status).toBe(200);
      expect(await swapped.json()).toEqual({ next: '/groups' });
      const me = await call('GET', '/me', { cookie: cookieFrom(swapped.headers) });
      expect(me.json.user).toMatchObject({ email: 'ada@example.com' });

      expect((await exchange({ code, verifier })).status).toBe(400);
    });

    it('refuses a code caught by another program that does not hold the verifier', async () => {
      const cfg = withProvider({ address: 'ada@example.com', verified: true });
      const { code } = await browserSignIn(cfg, await challengeFor(verifier));
      const thief = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
      const stolen = await exchange({ code, verifier: thief });
      expect(stolen.status).toBe(400);
      expect(stolen.headers.getSetCookie()).toEqual([]);
      // Trying used the code up: the real app cannot be raced into accepting it later either.
      expect((await exchange({ code, verifier })).status).toBe(400);
    });

    it('swaps codes for the Android app too', async () => {
      const cfg = withProvider({ address: 'ada@example.com', verified: true });
      const { code } = await browserSignIn(cfg, await challengeFor(verifier));
      const android =
        'Mozilla/5.0 (Linux; Android 16; wv) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36 EventideAndroid/0.4.0';
      expect((await exchange({ code, verifier }, android)).status).toBe(200);
    });

    it('swaps codes only for the app, so a link cannot sign a browser in to someone else', async () => {
      const cfg = withProvider({ address: 'ada@example.com', verified: true });
      const { code } = await browserSignIn(cfg, await challengeFor(verifier));
      const browser = await exchange({ code, verifier }, 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0');
      expect(browser.status).toBe(403);
    });

    it('refuses a malformed challenge', async () => {
      const cfg = withProvider({ address: 'ada@example.com', verified: true });
      expect((await call('GET', '/auth/github?handoff=short', { config: cfg })).status).toBe(400);
    });
  });

  it('checks where it sends you again at the callback, even if the sign-in cookie was tampered with', async () => {
    const cfg = withProvider({ address: 'grace@example.com', verified: true });
    const forged = {
      state: 'forged-state',
      verifier: 'v'.repeat(43),
      provider: 'github',
      next: 'https://evil.example',
    };
    const callback = await call('GET', '/auth/github/callback?code=good&state=forged-state', {
      cookie: `__Host-oauth=${btoa(JSON.stringify(forged))}`,
      config: cfg,
    });
    expect(callback.headers.get('Location')).toBe('/');
  });

  it('says so when a provider is not set up', async () => {
    expect((await call('GET', '/auth/google', { config: withProvider(null) })).status).toBe(404);
  });
});

describe('protecting the free allowances', () => {
  const closed = (allowedEmails: string[] = []) => config({ signups: { open: false, allowedEmails } });

  it('keeps strangers from creating accounts when sign-up is invite-only', async () => {
    const response = await call('POST', '/auth/dev', {
      body: { email: `stranger-${Date.now()}@example.com`, name: 'S' },
      config: closed(),
    });
    expect(response).toMatchObject({ status: 403, json: { error: { code: 'INVITE_ONLY' } } });
  });

  it('lets in a listed email, anyone with a valid invite, and everyone who already has an account', async () => {
    const owner = `owner-${Date.now()}@example.com`;
    expect(
      (await call('POST', '/auth/dev', { body: { email: owner.toUpperCase(), name: 'O' }, config: closed([owner]) }))
        .status,
    ).toBe(200);

    const host = await signIn(`host-${Date.now()}@example.com`, 'Host');
    const group = await call('POST', '/groups', {
      cookie: host,
      body: { name: 'G', currency: 'INR', displayName: 'H' },
    });
    const invite = await call('POST', `/groups/${group.json.group.id}/invites`, { cookie: host });
    const friend = `friend-${Date.now()}@example.com`;
    const withInvite = await call('POST', '/auth/dev', {
      body: { email: friend, name: 'F', next: `/join/${invite.json.invite.token}` },
      config: closed(),
    });
    expect(withInvite.status).toBe(200);
    const forged = await call('POST', '/auth/dev', {
      body: { email: `forger-${Date.now()}@example.com`, name: 'F', next: '/join/not-a-real-token' },
      config: closed(),
    });
    expect(forged.status).toBe(403);

    // The friend now has an account, so they can sign in again later without the invite.
    expect((await call('POST', '/auth/dev', { body: { email: friend, name: 'F' }, config: closed() })).status).toBe(
      200,
    );
  });

  it('sends a stranger signing in with a provider back with an explanation', async () => {
    const provider: OAuthProvider = {
      clientId: 'c',
      clientSecret: 's',
      authorizeUrl: 'https://provider.test/authorize',
      tokenUrl: 'https://provider.test/token',
      scope: 'email',
      profile: async () => ({ email: `oauth-stranger-${Date.now()}@example.com`, name: 'S' }),
    };
    const cfg = config({
      signups: { open: false, allowedEmails: [] },
      providers: { github: provider },
      fetch: async () => Response.json({ access_token: 't' }),
    });
    const start = await call('GET', '/auth/github?next=%2F', { config: cfg });
    const state = new URL(start.headers.get('Location') ?? '').searchParams.get('state');
    const callback = await call('GET', `/auth/github/callback?code=x&state=${state}`, {
      cookie: cookieFrom(start.headers, '__Host-oauth'),
      config: cfg,
    });
    expect(callback.headers.get('Location')).toBe('/?signin=invite-only');
  });

  it('answers 429 with Retry-After when a person or an address is over its limit', async () => {
    const cookie = await signIn(`busy-${Date.now()}@example.com`, 'Busy');
    const userLimited = config({ limit: async (bucket) => bucket !== 'user' });
    const limited = await app.request(
      `${ORIGIN}/api/groups`,
      { headers: { Cookie: cookie, 'cf-connecting-ip': '203.0.113.9' } },
      { db: db.app, config: userLimited },
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED');

    // The per-address limit applies before anything else, even to the health check.
    const seen: string[] = [];
    const ipLimited = config({
      limit: async (bucket, key) => {
        seen.push(`${bucket}:${key}`);
        return bucket !== 'ip';
      },
    });
    const health = await app.request(
      `${ORIGIN}/api/health`,
      { headers: { 'cf-connecting-ip': '203.0.113.9' } },
      { db: db.app, config: ipLimited },
    );
    expect(health.status).toBe(429);
    expect(seen).toEqual(['ip:203.0.113.9']);
  });
});

describe('the Google provider', () => {
  const answer =
    (body: unknown, ok = true) =>
    async () =>
      ok ? Response.json(body) : new Response('no', { status: 401 });

  it('reads a verified email and the name from Google', async () => {
    const provider = google('id', 'secret');
    expect(
      await provider.profile('t', answer({ email: 'Priya@Example.com', email_verified: true, name: 'Priya' }) as never),
    ).toEqual({ email: 'Priya@Example.com', name: 'Priya' });
  });

  it('refuses an email Google has not verified, and a failed lookup', async () => {
    const provider = google('id', 'secret');
    expect(await provider.profile('t', answer({ email: 'p@example.com', email_verified: false }) as never)).toBeNull();
    expect(await provider.profile('t', answer({}, false) as never)).toBeNull();
  });

  it('asks Google for only the basics: who you are and your email', () => {
    expect(google('id', 'secret').scope).toBe('openid email profile');
  });
});
