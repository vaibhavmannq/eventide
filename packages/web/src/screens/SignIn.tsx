import { useState } from 'preact/hooks';
import { api } from '../lib/api.ts';
import { providers } from '../lib/store.ts';

/** Where the Android APK and the Windows installer are published (.github/workflows/apps.yml). */
const DOWNLOADS = 'https://github.com/vaibhavmannq/eventide/releases/latest';

/** Signed out. The same night sky as the rest of the app, and one way in. */
export function SignIn({ next = location.pathname + location.search }: { next?: string }) {
  const outcome = new URLSearchParams(location.search).get('signin');
  const p = providers.value;
  const to = (provider: string) =>
    `/api/auth/${provider}?next=${encodeURIComponent(next.startsWith('/?signin=') ? '/' : next)}`;
  return (
    <main class="signin">
      <div class="signin-body">
        <p class="mono label">Split · settle · rest</p>
        <h1 class="name">Eventide</h1>
        <p class="tagline">Everyone’s even by nightfall.</p>
        <p class="lede">
          Share costs with your flat, a trip or a dinner, and settle up in as few payments as possible.
        </p>
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
        {outcome === 'failed' && (
          <p class="notice notice-bad" role="alert">
            Signing in didn’t work. Please try again.
          </p>
        )}
        {outcome === 'invite-only' && (
          <p class="notice notice-bad" role="alert">
            Eventide is invite-only for now. Ask a friend in a group for an invite link, then open it to join.
          </p>
        )}
        {p.dev && <DevSignIn next={next} />}
        <p class="signin-footer mono">
          <a class="link" href={DOWNLOADS}>
            Android &amp; Windows apps
          </a>
          <span aria-hidden="true"> · </span>
          <a class="link" href="/privacy">
            Privacy
          </a>
        </p>
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
        await api('POST', '/auth/dev', { body: { email, name, next } });
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
