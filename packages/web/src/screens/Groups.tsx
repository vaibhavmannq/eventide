import { Header } from '../components/Header.tsx';
import { Moon } from '../components/Moon.tsx';
import { money } from '../lib/money.ts';
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

export function Groups() {
  const first = me.value?.name.split(' ')[0] ?? '';
  const ids = groupIds.value.filter((id) => groups.value[id]);
  return (
    <>
      <Header />
      <main class="page">
        <p class="mono label">Your groups</p>
        <h1 class="title">
          {greeting()}
          {first && `, ${first}`}
        </h1>
        {ids.length === 0 ? (
          <div class="empty">
            <Moon lit={0.08} size={56} />
            <p>No groups yet. Start one for your flat, a trip, or a dinner, then invite people with a link.</p>
          </div>
        ) : (
          <ul class="cards">
            {ids.map((id) => {
              const cache = groups.value[id];
              if (!cache) return null;
              const s = standing(id);
              return (
                <li key={id}>
                  <a class="card group-card" href={`/groups/${id}`} onClick={(e) => onLink(e, `/groups/${id}`)}>
                    <Moon lit={s.lit} size={44} />
                    <span class="group-card-text">
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
        )}
        <div class="actions">
          <a class="pill pill-solid" href="/new" onClick={(e) => onLink(e, '/new')}>
            New group <span aria-hidden="true">+</span>
          </a>
        </div>
      </main>
    </>
  );
}
