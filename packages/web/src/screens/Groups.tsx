import { Header } from '../components/Header.tsx';
import { Moon } from '../components/Moon.tsx';
import { DOWNLOADS, inApp } from '../lib/apps.ts';
import { money } from '../lib/money.ts';
import { moonTonight } from '../lib/moonphase.ts';
import { onLink } from '../lib/router.ts';
import { settledness } from '../lib/settled.ts';
import { groupIds, groups, me, myMemberId, shownTransactions, summarise } from '../lib/store.ts';

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

/** Where you stand in one group, in a few words. */
export function standing(groupId: string): { text: string; tone: 'owed' | 'owe' | 'even'; lit: number } {
  const cache = groups.value[groupId];
  const mine = myMemberId(cache?.group);
  const summaries = summarise(groupId);
  const lit = settledness(summaries, shownTransactions(groupId));
  const parts = summaries
    .map((s) => ({ currency: s.currency, amount: mine ? (s.balances.get(mine) ?? 0) : 0 }))
    .filter((p) => p.amount !== 0);
  if (parts.length === 0) {
    return { text: lit === 1 ? 'Everyone’s even' : 'You’re settled up', tone: 'even', lit };
  }
  const owed = parts.filter((p) => p.amount > 0);
  const owe = parts.filter((p) => p.amount < 0);
  const list = (ps: typeof parts) => ps.map((p) => money(Math.abs(p.amount), p.currency)).join(' + ');
  if (owe.length === 0) return { text: `You’re owed ${list(owed)}`, tone: 'owed', lit };
  if (owed.length === 0) return { text: `You owe ${list(owe)}`, tone: 'owe', lit };
  return { text: `You’re owed ${list(owed)}, you owe ${list(owe)}`, tone: 'owe', lit };
}

/** The log line, in the portfolio's voice: today, now, and tonight's real moon. */
function Log() {
  const now = new Date();
  const moon = moonTonight(now);
  const date = now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const time = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return (
    <p class="mono log">
      <span>
        Log · {date} · {time}
      </span>
      <span class="tonight">
        {moon.name} · {Math.round(moon.lit * 100)}% lit
      </span>
    </p>
  );
}

export function Groups() {
  const first = me.value?.name.split(' ')[0] ?? '';
  const ids = groupIds.value.filter((id) => groups.value[id]);
  const owing = ids.some((id) => standing(id).tone !== 'even');
  return (
    <>
      <Header />
      <main class="page">
        <Log />
        <h1 class="greeting">
          {greeting()}
          {first && `, ${first}`}
          <em>
            {ids.length === 0 ? 'Nothing to settle yet.' : owing ? 'Here’s where everyone stands.' : 'Everyone’s even.'}
          </em>
        </h1>
        {ids.length === 0 ? (
          <div class="empty">
            <Moon lit={0.08} size={56} />
            <ol class="steps">
              <li>
                <strong>Start a group</strong> for your flat, a trip or a dinner.
              </li>
              <li>
                <strong>Add the people.</strong> Just their names: they don’t need the app. Send an invite link when
                they want to see it.
              </li>
              <li>
                <strong>Add what you spend.</strong> Eventide works out the fewest payments to settle up.
              </li>
            </ol>
          </div>
        ) : (
          <>
            <h2 class="mono label">Your groups</h2>
            <ul class="group-list">
              {ids.map((id) => {
                const cache = groups.value[id];
                if (!cache) return null;
                const s = standing(id);
                return (
                  <li key={id}>
                    <a class="group-row" href={`/groups/${id}`} onClick={(e) => onLink(e, `/groups/${id}`)}>
                      <Moon lit={s.lit} size={44} />
                      <span class="group-row-text">
                        <span class="group-name">{cache.group.name}</span>
                        <span class={`standing standing-${s.tone}`}>{s.text}</span>
                      </span>
                      <span class="mono chevron" aria-hidden="true">
                        →
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <div class="actions">
          <a class="pill pill-solid" href="/new" onClick={(e) => onLink(e, '/new')}>
            New group <span aria-hidden="true">+</span>
          </a>
        </div>
        {!inApp && (
          <p class="apps-link mono">
            <a class="link" href={DOWNLOADS}>
              Android, Windows &amp; Linux apps
            </a>
          </p>
        )}
      </main>
    </>
  );
}
