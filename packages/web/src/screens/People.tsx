import { useState } from 'preact/hooks';
import { Header } from '../components/Header.tsx';
import { go } from '../lib/router.ts';
import {
  addMember,
  createInvite,
  deleteGroup,
  groups,
  leaveGroup,
  myMemberId,
  removeMember,
  summarise,
} from '../lib/store.ts';

export function People({ groupId }: { groupId: string }) {
  const cache = groups.value[groupId];
  const [name, setName] = useState('');
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [confirmName, setConfirmName] = useState('');
  if (!cache) return null;

  const { group } = cache;
  const mine = myMemberId(group);
  const iStarted = group.members.some((m) => m.id === mine && m.role === 'owner');
  const active = group.members.filter((m) => !m.leftAt);
  const summaries = summarise(groupId);
  const balanceOf = (memberId: string) => summaries.some((s) => (s.balances.get(memberId) ?? 0) !== 0);
  const fail = (e: unknown) =>
    setError(e instanceof TypeError ? 'You’re offline. This needs a connection.' : (e as Error).message);

  return (
    <>
      <Header back={{ to: `/groups/${groupId}`, label: group.name }} />
      <main class="page narrow">
        <p class="mono label">People</p>
        <h1 class="title">Who’s in {group.name}</h1>

        <ul class="people">
          {active.map((m) => {
            const canRemove = m.id !== mine && (iStarted || m.userId === null);
            return (
              <li key={m.id} class="person">
                <span>
                  {m.displayName}
                  {m.id === mine && <span class="muted"> (you)</span>}
                </span>
                <span class="person-right">
                  <span class="mono muted small">
                    {m.userId ? (m.role === 'owner' ? 'Started it' : 'Joined') : 'No account yet'}
                  </span>
                  {canRemove && (
                    <button
                      type="button"
                      class="mono link link-bad"
                      aria-label={`Remove ${m.displayName}`}
                      title={balanceOf(m.id) ? 'They need a zero balance first' : undefined}
                      onClick={async () => {
                        if (!confirm(`Remove ${m.displayName} from ${group.name}?`)) return;
                        setError('');
                        await removeMember(groupId, m.id).catch(fail);
                      }}
                    >
                      Remove
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        {error && (
          <p class="notice notice-bad" role="alert">
            {error}
          </p>
        )}

        <section class="section stack">
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
                      navigator.share({ title: `Join ${group.name} on Eventide`, url: link }).catch(() => {})
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
              <button type="button" class="pill pill-solid" onClick={() => createInvite(groupId).then(setLink, fail)}>
                Create invite link
              </button>
            </div>
          )}
        </section>

        <form
          class="section stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setError('');
            try {
              await addMember(groupId, name.trim());
              setName('');
            } catch (err) {
              fail(err);
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

        <section class="danger-zone stack">
          <h2 class="subtitle">Leave or delete</h2>
          <p class="muted small">You can leave once your balance here is zero, so nobody’s debt disappears with you.</p>
          <div class="actions">
            <button
              type="button"
              class="pill pill-danger"
              onClick={async () => {
                if (!confirm(`Leave ${group.name}?`)) return;
                try {
                  await leaveGroup(groupId);
                  go('/', { replace: true });
                } catch (err) {
                  fail(err);
                }
              }}
            >
              Leave group
            </button>
          </div>
          {iStarted && (
            <form
              class="stack"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await deleteGroup(groupId);
                  go('/', { replace: true });
                } catch (err) {
                  fail(err);
                }
              }}
            >
              <p class="muted small">
                Deleting removes {group.name} for everyone, including any amounts still owed. Its history is kept but no
                one will see it again. Type the group’s name to confirm.
              </p>
              <label class="field">
                <span class="mono">Group name</span>
                <input value={confirmName} onInput={(e) => setConfirmName(e.currentTarget.value)} autoComplete="off" />
              </label>
              <div class="actions">
                <button class="pill pill-danger" type="submit" disabled={confirmName.trim() !== group.name}>
                  Delete group for everyone
                </button>
              </div>
            </form>
          )}
        </section>
      </main>
    </>
  );
}
