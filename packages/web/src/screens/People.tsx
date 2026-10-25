import { useState } from 'preact/hooks';
import { Header } from '../components/Header.tsx';
import { addMember, createInvite, groups, myMemberId } from '../lib/store.ts';

export function People({ groupId }: { groupId: string }) {
  const cache = groups.value[groupId];
  const [name, setName] = useState('');
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  if (!cache) return null;
  const mine = myMemberId(cache.group);
  const offline = (e: unknown) =>
    setError(e instanceof TypeError ? 'You’re offline. This needs a connection.' : (e as Error).message);

  return (
    <>
      <Header back={{ to: `/groups/${groupId}`, label: cache.group.name }} />
      <main class="page narrow">
        <p class="mono label">People</p>
        <h1 class="title">Who’s in {cache.group.name}</h1>

        <ul class="people">
          {cache.group.members.map((m) => (
            <li key={m.id} class="person">
              <span>
                {m.displayName}
                {m.id === mine && <span class="muted"> (you)</span>}
              </span>
              <span class="mono muted small">
                {m.userId ? (m.role === 'owner' ? 'Started the group' : 'Joined') : 'No account yet'}
              </span>
            </li>
          ))}
        </ul>

        <section class="card stack">
          <h2 class="subtitle">Invite with a link</h2>
          <p class="muted small">
            Anyone with the link can join for 7 days. People you added by name can use it to claim their place.
          </p>
          {link ? (
            <>
              <input
                class="link-box"
                readOnly
                value={link}
                onFocus={(e) => e.currentTarget.select()}
                aria-label="Invite link"
              />
              <div class="actions">
                {'share' in navigator && (
                  <button
                    type="button"
                    class="pill pill-solid"
                    onClick={() =>
                      navigator.share({ title: `Join ${cache.group.name} on Eventide`, url: link }).catch(() => {})
                    }
                  >
                    Share
                  </button>
                )}
                <button
                  type="button"
                  class="pill"
                  onClick={async () => {
                    await navigator.clipboard.writeText(link);
                    setCopied(true);
                  }}
                >
                  {copied ? 'Copied' : 'Copy link'}
                </button>
              </div>
            </>
          ) : (
            <div class="actions">
              <button
                type="button"
                class="pill pill-solid"
                onClick={() => createInvite(groupId).then(setLink, offline)}
              >
                Create invite link
              </button>
            </div>
          )}
        </section>

        <form
          class="card stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setError('');
            try {
              await addMember(groupId, name.trim());
              setName('');
            } catch (err) {
              offline(err);
            }
          }}
        >
          <h2 class="subtitle">Add someone by name</h2>
          <p class="muted small">For people without the app yet. You can split with them straight away.</p>
          <label class="field">
            <span class="mono">Name</span>
            <input value={name} onInput={(e) => setName(e.currentTarget.value)} required maxLength={100} />
          </label>
          <div class="actions">
            <button class="pill" type="submit">
              Add
            </button>
          </div>
        </form>
        {error && (
          <p class="notice notice-bad" role="alert">
            {error}
          </p>
        )}
      </main>
    </>
  );
}
