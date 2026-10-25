import { onLink } from '../lib/router.ts';
import { scrolled } from '../lib/sky.ts';
import { me, online, outbox, pendingCount, signOut, syncing } from '../lib/store.ts';

/** The top line: home on the left; on the right, whether everything is saved. */
export function Header({ back }: { back?: { to: string; label: string } }) {
  const failed = outbox.value.filter((i) => i.failed).length;
  const status = !online.value
    ? `Offline${pendingCount.value ? ` · ${pendingCount.value} waiting` : ''}`
    : failed
      ? `${failed} not saved`
      : pendingCount.value || syncing.value
        ? 'Saving…'
        : 'All saved';
  return (
    <header class={scrolled.value ? 'topbar scrolled' : 'topbar'}>
      {back ? (
        <a class="mono link" href={back.to} onClick={(e) => onLink(e, back.to)}>
          ← {back.label}
        </a>
      ) : (
        <a class="mono brand" href="/" onClick={(e) => onLink(e, '/')}>
          Eventide
        </a>
      )}
      <div class="topbar-right">
        <span class={`mono status${failed ? ' status-bad' : ''}`} role="status" aria-live="polite">
          {status}
        </span>
        {!back && me.value && (
          <button type="button" class="mono link" onClick={() => void signOut()}>
            Sign out
          </button>
        )}
      </div>
    </header>
  );
}
