import { useEffect, useState } from 'preact/hooks';
import { Header } from '../components/Header.tsx';
import { api } from '../lib/api.ts';
import { go } from '../lib/router.ts';
import { me, sync } from '../lib/store.ts';

interface Preview {
  groupId: string;
  groupName: string;
  unclaimed: { id: string; displayName: string }[];
}

export function Join({ token }: { token: string }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState(me.value?.name.split(' ')[0] ?? '');

  useEffect(() => {
    api<{ invite: Preview }>('GET', `/invites/${encodeURIComponent(token)}`).then(
      (r) => setPreview(r.invite),
      () => setError('This invite link isn’t valid any more. Ask for a new one.'),
    );
  }, [token]);

  async function join(body: { displayName: string } | { claim: string }) {
    try {
      const { groupId } = await api<{ groupId: string }>('POST', `/invites/${encodeURIComponent(token)}/accept`, {
        body,
      });
      await sync();
      go(`/groups/${groupId}`, { replace: true });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <Header />
      <main class="page narrow">
        <p class="mono label">Invitation</p>
        {error && (
          <p class="notice notice-bad" role="alert">
            {error}
          </p>
        )}
        {!preview && !error && <p class="muted">Opening the invitation…</p>}
        {preview && (
          <>
            <h1 class="title">Join {preview.groupName}</h1>
            {preview.unclaimed.length > 0 && (
              <section class="stack">
                <h2 class="subtitle">Are you one of these?</h2>
                <p class="muted small">
                  Someone added you by name. Claim it to keep everything already split with you.
                </p>
                <div class="actions">
                  {preview.unclaimed.map((m) => (
                    <button key={m.id} type="button" class="pill" onClick={() => void join({ claim: m.id })}>
                      I’m {m.displayName}
                    </button>
                  ))}
                </div>
              </section>
            )}
            <form
              class="card stack"
              onSubmit={(e) => {
                e.preventDefault();
                void join({ displayName: name.trim() });
              }}
            >
              <h2 class="subtitle">{preview.unclaimed.length > 0 ? 'Or join as someone new' : 'Join as'}</h2>
              <label class="field">
                <span class="mono">Your name in this group</span>
                <input value={name} onInput={(e) => setName(e.currentTarget.value)} required maxLength={100} />
              </label>
              <div class="actions">
                <button class="pill pill-solid" type="submit">
                  Join {preview.groupName}
                </button>
              </div>
            </form>
          </>
        )}
      </main>
    </>
  );
}
