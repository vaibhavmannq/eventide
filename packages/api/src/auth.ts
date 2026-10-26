import {
  createHandoff,
  createSession,
  deleteSession,
  inviteIsValid,
  newToken,
  sha256,
  takeHandoff,
  type User,
  upsertUser,
  userExists,
  userForSession,
} from '@eventide/db';
import { Hono, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Bindings, ProviderName } from './config.ts';
import { HttpError } from './errors.ts';
import { devLogin, handoffExchange } from './schemas.ts';

export interface AppEnv {
  Bindings: Bindings;
  Variables: { user: User; requestId: string };
}

/**
 * The session cookie. `__Host-` (Hono's "host" prefix) means the browser only accepts it over HTTPS, for this exact
 * host and path /, so no subdomain can set or read it. HttpOnly keeps it from scripts; SameSite=Lax keeps it off
 * cross-site requests that could change anything.
 */
const SESSION = 'session';
const OAUTH = 'oauth';
const secure = { prefix: 'host', secure: true, httpOnly: true, sameSite: 'Lax', path: '/' } as const;

/** Rejects requests without a valid session, and makes the user available to the route. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION, 'host');
  const user = token ? await userForSession(c.env.db, token) : null;
  if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in first');
  if (c.env.config.limit && !(await c.env.config.limit('user', user.id))) throw tooMany();
  c.set('user', user);
  await next();
};

/** The invite token in a path like /join/<token>, if there is one. */
const inviteIn = (path: string | undefined) => /^\/join\/([^/?#]+)/.exec(path ?? '')?.[1];

export const tooMany = () => new HttpError(429, 'RATE_LIMITED', 'Too many requests. Try again in a minute.');

/** Checks the person may have an account (invite-only, when sign-up is closed), and creates or updates it. */
async function admit(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  email: string,
  name: string,
  invite?: string,
): Promise<User> {
  const { signups } = c.env.config;
  if (!signups.open && !(await userExists(c.env.db, email))) {
    const listed = signups.allowedEmails.includes(email.toLowerCase());
    if (!listed && !(invite && (await inviteIsValid(c.env.db, invite)))) {
      throw new HttpError(403, 'INVITE_ONLY', 'Eventide is invite-only for now. Ask a friend for an invite link.');
    }
  }
  return upsertUser(c.env.db, email, name);
}

async function startSession(c: Parameters<MiddlewareHandler<AppEnv>>[0], userId: string): Promise<void> {
  const { token, expiresAt } = await createSession(c.env.db, userId);
  setCookie(c, SESSION, token, { ...secure, expires: expiresAt });
}

async function signIn(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  email: string,
  name: string,
  invite?: string,
): Promise<User> {
  const user = await admit(c, email, name, invite);
  await startSession(c, user.id);
  return user;
}

/**
 * The Windows app names itself in its user agent. Only it can swap a handoff code, so a link that would sign an
 * ordinary browser in to someone else's account (with a code and verifier of their own) does nothing.
 */
const fromDesktopApp = (c: Parameters<MiddlewareHandler<AppEnv>>[0]) =>
  /\bEventideDesktop\//.test(c.req.header('User-Agent') ?? '');

/** A PKCE-style challenge: base64url SHA-256, 43 characters. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** Only same-site paths, so a crafted link cannot send someone elsewhere after signing in. */
function safeNext(next: string | undefined): string {
  return next?.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

function providerName(name: string): ProviderName {
  if (name !== 'github' && name !== 'google') throw new HttpError(404, 'NOT_FOUND', 'Not found');
  return name;
}

interface OAuthState {
  state: string;
  verifier: string;
  provider: ProviderName;
  next: string;
  /** Set when the Windows app started this sign-in in the browser: its challenge, for the handoff code. */
  handoff?: string;
}

export const auth = new Hono<AppEnv>()
  /** Which sign-in buttons the app should show. */
  .get('/providers', (c) =>
    c.json({
      github: Boolean(c.env.config.providers.github),
      google: Boolean(c.env.config.providers.google),
      dev: c.env.config.devLogin,
    }),
  )

  /**
   * Starts "Sign in with GitHub/Google": OAuth 2 authorisation code flow with PKCE. The state and the PKCE
   * verifier go in a short-lived cookie, so the callback can check the response belongs to this browser's own
   * sign-in (stopping login CSRF) and only this browser can exchange the code.
   */
  .get('/:provider', async (c) => {
    const name = providerName(c.req.param('provider'));
    const provider = c.env.config.providers[name];
    if (!provider) throw new HttpError(404, 'NOT_FOUND', `Sign-in with ${name} is not set up`);

    const handoff = c.req.query('handoff');
    if (handoff !== undefined && !CHALLENGE.test(handoff)) throw new HttpError(400, 'BAD_REQUEST', 'Bad handoff');
    const flow: OAuthState = {
      state: newToken(),
      verifier: newToken(),
      provider: name,
      next: safeNext(c.req.query('next')),
      ...(handoff ? { handoff } : {}),
    };
    setCookie(c, OAUTH, btoa(JSON.stringify(flow)), { ...secure, maxAge: 600 });

    const url = new URL(provider.authorizeUrl);
    url.search = new URLSearchParams({
      client_id: provider.clientId,
      redirect_uri: new URL(`/api/auth/${name}/callback`, c.req.url).toString(),
      response_type: 'code',
      scope: provider.scope,
      state: flow.state,
      code_challenge: base64url(await sha256(flow.verifier)),
      code_challenge_method: 'S256',
    }).toString();
    return c.redirect(url.toString(), 302);
  })

  .get('/:provider/callback', async (c) => {
    const name = providerName(c.req.param('provider'));
    const provider = c.env.config.providers[name];
    const raw = getCookie(c, OAUTH, 'host');
    deleteCookie(c, OAUTH, secure);
    const failed = (reason: string) => {
      c.env.config.log({ event: 'signin_failed', provider: name, reason, requestId: c.get('requestId') });
      return c.redirect('/?signin=failed', 302);
    };

    let flow: OAuthState | undefined;
    try {
      flow = raw ? (JSON.parse(atob(raw)) as OAuthState) : undefined;
    } catch {
      flow = undefined;
    }
    const code = c.req.query('code');
    if (!provider || !flow || flow.provider !== name || !code || c.req.query('state') !== flow.state) {
      return failed('state');
    }

    const token = await c.env.config.fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        code,
        redirect_uri: new URL(`/api/auth/${name}/callback`, c.req.url).toString(),
        grant_type: 'authorization_code',
        code_verifier: flow.verifier,
      }),
    });
    const { access_token: accessToken } = token.ok ? ((await token.json()) as { access_token?: string }) : {};
    if (!accessToken) return failed('token');

    const profile = await provider.profile(accessToken, c.env.config.fetch);
    if (!profile) return failed('no verified email');

    let user: User;
    try {
      user = await admit(c, profile.email, profile.name, inviteIn(flow.next));
    } catch (error) {
      if (error instanceof HttpError && error.code === 'INVITE_ONLY') return c.redirect('/?signin=invite-only', 302);
      throw error;
    }
    if (flow.handoff) {
      // Started by the Windows app: this browser gets no session, the app gets a code for one. The code travels
      // in the fragment, which never reaches a server or its logs.
      const handoffCode = await createHandoff(c.env.db, user.id, flow.handoff, flow.next);
      return c.redirect(`/desktop-return#code=${handoffCode}`, 302);
    }
    await startSession(c, user.id);
    return c.redirect(flow.next, 302);
  })

  /** The Windows app swaps a handoff code, and the verifier only it holds, for a session in its own web view. */
  .post('/handoff', async (c) => {
    if (!fromDesktopApp(c)) throw new HttpError(403, 'FORBIDDEN', 'Only the Eventide app can do this');
    const { code, verifier } = handoffExchange.parse(await c.req.json());
    const handoff = await takeHandoff(c.env.db, code);
    if (!handoff || base64url(await sha256(verifier)) !== handoff.challenge) {
      c.env.config.log({ event: 'handoff_refused', requestId: c.get('requestId') });
      throw new HttpError(400, 'HANDOFF_INVALID', 'That sign-in has expired. Please sign in again.');
    }
    await startSession(c, handoff.userId);
    return c.json({ next: handoff.next });
  })

  .post('/dev', async (c) => {
    if (!c.env.config.devLogin) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    const { email, name, next } = devLogin.parse(await c.req.json());
    return c.json({ user: await signIn(c, email, name, inviteIn(next)) });
  })

  .post('/logout', async (c) => {
    const token = getCookie(c, SESSION, 'host');
    if (token) await deleteSession(c.env.db, token);
    deleteCookie(c, SESSION, secure);
    return c.body(null, 204);
  });
