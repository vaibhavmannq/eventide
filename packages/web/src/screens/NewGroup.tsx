import { useState } from 'preact/hooks';
import { Header } from '../components/Header.tsx';
import { currencies } from '../lib/currency.ts';
import { go } from '../lib/router.ts';
import { createGroup, me } from '../lib/store.ts';

export function NewGroup() {
  const [name, setName] = useState('');
  // INR first; the list offers every other currency.
  const [currency, setCurrency] = useState('INR');
  const [displayName, setDisplayName] = useState(me.value?.name.split(' ')[0] ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Header back={{ to: '/', label: 'Groups' }} />
      <main class="page narrow">
        <p class="mono label">New group</p>
        <h1 class="title">Start a group</h1>
        <form
          class="form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              const id = await createGroup({ name: name.trim(), currency, displayName: displayName.trim() });
              go(`/groups/${id}`, { replace: true });
            } catch (err) {
              setError(
                err instanceof TypeError
                  ? 'You’re offline. Creating a group needs a connection.'
                  : String((err as Error).message),
              );
              setBusy(false);
            }
          }}
        >
          <label class="field">
            <span class="mono">Group name</span>
            <input
              value={name}
              onInput={(e) => setName(e.currentTarget.value)}
              placeholder="Flat 4, Goa trip…"
              required
              maxLength={100}
            />
          </label>
          <label class="field">
            <span class="mono">Currency</span>
            <select value={currency} onChange={(e) => setCurrency(e.currentTarget.value)}>
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label class="field">
            <span class="mono">Your name in this group</span>
            <input
              value={displayName}
              onInput={(e) => setDisplayName(e.currentTarget.value)}
              required
              maxLength={100}
            />
          </label>
          {error && (
            <p class="notice notice-bad" role="alert">
              {error}
            </p>
          )}
          <div class="actions">
            <button class="pill pill-solid" type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create group'}
            </button>
          </div>
        </form>
      </main>
    </>
  );
}
