import type { Pool } from '@eventide/db';

/** The verified identity a provider vouches for. Sign-in is refused without a verified email. */
export interface Profile {
  email: string;
  name: string;
}

export interface OAuthProvider {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  profile(accessToken: string, fetcher: typeof fetch): Promise<Profile | null>;
}

export type ProviderName = 'github' | 'google';

export interface Config {
  providers: Partial<Record<ProviderName, OAuthProvider>>;
  /**
   * Who may create an account. Closed (the default): only someone arriving through a valid invite link, or whose
   * email is listed. Anyone who already has an account can always sign in. Keeps strangers from spending the
   * free allowances on accounts of their own.
   */
  signups: { open: boolean; allowedEmails: readonly string[] };
  /**
   * Rate limits (Cloudflare's rate limiting binding in the Worker). Returns false when `key` is over its limit.
   * Absent: no limits (tests, and the Node entry point unless given one).
   */
  limit?: (bucket: 'ip' | 'user', key: string) => Promise<boolean>;
  /** Sign in by typing an email, with no provider. Local development and tests only; never set in production. */
  devLogin: boolean;
  /** Injected so tests can stand in for GitHub and Google. */
  fetch: typeof fetch;
  log: (entry: Record<string, unknown>) => void;
}

/** What each request gets: a database pool and the configuration. */
export interface Bindings {
  db: Pool;
  config: Config;
}

export function github(clientId: string, clientSecret: string): OAuthProvider {
  return {
    clientId,
    clientSecret,
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    async profile(token, fetcher) {
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'eventide' };
      const [user, emails] = await Promise.all([
        fetcher('https://api.github.com/user', { headers }),
        fetcher('https://api.github.com/user/emails', { headers }),
      ]);
      if (!user.ok || !emails.ok) return null;
      const { name, login } = (await user.json()) as { name: string | null; login: string };
      const list = (await emails.json()) as { email: string; primary: boolean; verified: boolean }[];
      const primary = list.find((e) => e.primary && e.verified);
      return primary ? { email: primary.email, name: name || login } : null;
    },
  };
}

export function google(clientId: string, clientSecret: string): OAuthProvider {
  return {
    clientId,
    clientSecret,
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    async profile(token, fetcher) {
      const response = await fetcher('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return null;
      const info = (await response.json()) as { email?: string; email_verified?: boolean; name?: string };
      if (!info.email || info.email_verified !== true) return null;
      return { email: info.email, name: info.name || info.email.split('@')[0] || 'Someone' };
    },
  };
}
