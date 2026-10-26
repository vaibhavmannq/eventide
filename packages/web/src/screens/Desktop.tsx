import { useEffect, useState } from 'preact/hooks';
import { ApiError, api } from '../lib/api.ts';

/** The fragment's parameters (#code=…&verifier=…), read once and then wiped from the address bar and history. */
function takeFragment(): URLSearchParams {
  const params = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname);
  return params;
}

/**
 * In the browser, after signing in for the Windows app: hands the one-time code to the app through its eventide://
 * link (docs/DESIGN.md §9.1). This browser stays signed out.
 */
export function DesktopReturn() {
  const [link] = useState(() => {
    const code = takeFragment().get('code');
    return code ? `eventide://signin?code=${encodeURIComponent(code)}` : null;
  });
  useEffect(() => {
    if (link) location.href = link;
  }, [link]);
  return (
    <main class="signin">
      <div class="signin-body">
        <p class="mono label">Signed in</p>
        <h1 class="title">Back to the app</h1>
        {link ? (
          <>
            <p class="lede">Your browser will ask to open Eventide. Allow it, and you’re in. You can close this tab.</p>
            <div class="actions">
              <a class="pill pill-solid" href={link}>
                Open Eventide <span aria-hidden="true">→</span>
              </a>
            </div>
          </>
        ) : (
          <p class="notice notice-bad" role="alert">
            This sign-in link is incomplete. Start again from the Eventide app.
          </p>
        )}
      </div>
    </main>
  );
}

/** Inside the Windows app: swaps the code, and the verifier only the app holds, for a session. */
export function DesktopFinish() {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const params = takeFragment();
    api<{ next: string }>('POST', '/auth/handoff', {
      body: { code: params.get('code'), verifier: params.get('verifier') },
    }).then(
      ({ next }) => location.replace(next),
      (error: unknown) => {
        if (!(error instanceof ApiError)) console.error(error);
        setFailed(true);
      },
    );
  }, []);
  return (
    <main class="signin" aria-busy={!failed}>
      <div class="signin-body">
        {failed ? (
          <>
            <p class="notice notice-bad" role="alert">
              That sign-in has expired or was already used. Please sign in again.
            </p>
            <div class="actions">
              <a class="pill" href="/">
                Sign in again
              </a>
            </div>
          </>
        ) : (
          <p class="mono label">Signing you in…</p>
        )}
      </div>
    </main>
  );
}
