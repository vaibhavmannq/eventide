import { useState } from 'preact/hooks';
import { api } from '../lib/api.ts';
import { providers } from '../lib/store.ts';

/** Signed out. The night sea from the portfolio behind it, and one way in. */
export function SignIn({ next = location.pathname + location.search }: { next?: string }) {
  const failed = new URLSearchParams(location.search).get('signin') === 'failed';
  const p = providers.value;
  const to = (provider: string) =>
    `/api/auth/${provider}?next=${encodeURIComponent(next === '/?signin=failed' ? '/' : next)}`;
  return (
    <main class="signin">
      <div class="signin-sky" aria-hidden="true" />
      <div class="signin-body">
        <p class="mono label">Split · settle · rest</p>
        <h1 class="name">Eventide</h1>
        <p class="tagline">Everyone’s even by nightfall.</p>
        <p class="lede">
          Share costs with your flat, a trip or a dinner, and settle up in as few payments as possible.
        </p>
        {failed && (
          <p class="notice notice-bad" role="alert">
            Signing in didn’t work. Please try again.
          </p>
        )}
        <div class="actions">
          {p.github && (
            <a class="pill pill-solid" href={to('github')}>
              Sign in with GitHub <span aria-hidden="true">→</span>
            </a>
          )}
          {p.google && (
            <a class="pill" href={to('google')}>
              Sign in with Google
            </a>
          )}
        </div>
        {p.dev && <DevSignIn next={next} />}
      </div>
    </main>
  );
}

/** Local development only: the API offers this when DEV_LOGIN is on, which production never has. */
function DevSignIn({ next }: { next: string }) {
  const [email, setEmail] = useState('alice@example.com');
  const [name, setName] = useState('Alice');
  return (
    <form
      class="dev-signin"
      onSubmit={async (e) => {
        e.preventDefault();
        await api('POST', '/auth/dev', { body: { email, name } });
        location.href = next;
      }}
    >
      <p class="mono label">Development sign-in</p>
      <label class="field">
        <span class="mono">Email</span>
        <input value={email} onInput={(e) => setEmail(e.currentTarget.value)} type="email" required />
      </label>
      <label class="field">
        <span class="mono">Name</span>
        <input value={name} onInput={(e) => setName(e.currentTarget.value)} required />
      </label>
      <button class="pill" type="submit">
        Sign in
      </button>
    </form>
  );
}
