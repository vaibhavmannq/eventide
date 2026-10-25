import type { Transaction } from '@eventide/ledger';
import { splitAmount } from '@eventide/ledger';
import { useEffect } from 'preact/hooks';
import { Header } from '../components/Header.tsx';
import { Moon } from '../components/Moon.tsx';
import { longDate, money, today } from '../lib/money.ts';
import { onLink } from '../lib/router.ts';
import {
  dismiss,
  groups,
  type Member,
  myMemberId,
  outbox,
  record,
  refreshGroup,
  type Shown,
  shownTransactions,
  summarise,
} from '../lib/store.ts';
import { standing } from './Groups.tsx';

export function GroupScreen({ id }: { id: string }) {
  useEffect(() => {
    refreshGroup(id).catch(() => {}); // fresh on open; the cached copy shows meanwhile
  }, [id]);

  const cache = groups.value[id];
  if (!cache) {
    return (
      <>
        <Header back={{ to: '/', label: 'Groups' }} />
        <main class="page">
          <p class="muted">Loading…</p>
        </main>
      </>
    );
  }
  const { group } = cache;
  const names = new Map(group.members.map((m) => [m.id, m.displayName]));
  const name = (memberId: string) => names.get(memberId) ?? 'Someone';
  const active = group.members.filter((m) => !m.leftAt);
  const mine = myMemberId(group);
  const shown = shownTransactions(id);
  const summaries = summarise(id);
  const s = standing(id);
  const failed = outbox.value.filter((i) => i.groupId === id && i.failed);

  return (
    <>
      <Header back={{ to: '/', label: 'Groups' }} />
      <main class="page group-page">
        <div class="group-head">
          <div>
            <p class="mono label">
              {active.length} {active.length === 1 ? 'person' : 'people'} · {group.defaultCurrency}
            </p>
            <h1 class="title">{group.name}</h1>
          </div>
          <a class="pill pill-small" href={`/groups/${id}/people`} onClick={(e) => onLink(e, `/groups/${id}/people`)}>
            People & invite
          </a>
        </div>

        <div class="group-columns">
          <section class="summary" aria-labelledby="where">
            <h2 class="mono label" id="where">
              I · Where you stand
            </h2>
            <div class="standing-block">
              <Moon lit={s.lit} size={72} label={s.lit === 1 ? 'Full moon: everyone is even' : undefined} />
              <div>
                <p class={`standing-big standing-${s.tone}`}>{s.text}</p>
                {s.lit === 1 && shown.length > 0 && <p class="muted">Full moon. Nothing to settle.</p>}
              </div>
            </div>

            {summaries.some((x) => x.settleUp.length > 0) && (
              <div class="section">
                <h2 class="mono label">II · Settle up</h2>
                <ul class="settle-list">
                  {summaries.flatMap((x) =>
                    x.settleUp.map((t) => (
                      <li key={`${x.currency}:${t.from}:${t.to}`} class="settle-row">
                        <span>
                          <strong>{t.from === mine ? 'You' : name(t.from)}</strong> {t.from === mine ? 'pay' : 'pays'}{' '}
                          <strong>{t.to === mine ? 'you' : name(t.to)}</strong>
                        </span>
                        <span class="amount">{money(t.amount, x.currency)}</span>
                        <button
                          type="button"
                          class="mono link"
                          onClick={() =>
                            void record(id, {
                              description: '',
                              occurredOn: today(),
                              transaction: {
                                kind: 'settlement',
                                currency: x.currency,
                                from: t.from,
                                to: t.to,
                                amount: t.amount,
                              },
                            })
                          }
                        >
                          Mark paid →
                        </button>
                      </li>
                    )),
                  )}
                </ul>
                <p class="muted small">
                  The fewest payments that make everyone even. Someone may be asked to pay a person they never owed
                  directly; the totals still come out right.
                </p>
              </div>
            )}
          </section>

          <section class="activity section" aria-labelledby="activity">
            <h2 class="mono label" id="activity">
              {summaries.some((x) => x.settleUp.length > 0) ? 'III' : 'II'} · Activity
            </h2>
            {failed.length > 0 && (
              <ul class="failed-list">
                {failed.map((item) => (
                  <li key={item.key} class="notice notice-bad">
                    <span>
                      “{item.description || 'Payment'}”: {item.failed}
                    </span>
                    <button type="button" class="mono link" onClick={() => void dismiss(item)}>
                      Dismiss
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {shown.length === 0 ? (
              <p class="muted">Nothing yet. Add the first expense.</p>
            ) : (
              <ActivityList id={id} shown={shown} mine={mine} name={name} />
            )}
          </section>
        </div>

        <div class="fab">
          <a class="pill pill-solid" href={`/groups/${id}/add`} onClick={(e) => onLink(e, `/groups/${id}/add`)}>
            Add expense <span aria-hidden="true">+</span>
          </a>
        </div>
      </main>
    </>
  );
}

function ActivityList({
  id,
  shown,
  mine,
  name,
}: {
  id: string;
  shown: Shown[];
  mine: string | undefined;
  name: (memberId: string) => string;
}) {
  const days = new Map<string, Shown[]>();
  for (const t of shown) days.set(t.occurredOn, [...(days.get(t.occurredOn) ?? []), t]);
  return (
    <ol class="days">
      {[...days].map(([day, items]) => (
        <li key={day}>
          <h3 class="mono day">{longDate(day)}</h3>
          <ul class="rows">
            {items.map((t) => (
              <li key={t.id}>
                <a class="row" href={`/groups/${id}/t/${t.id}`} onClick={(e) => onLink(e, `/groups/${id}/t/${t.id}`)}>
                  <span class="row-main">
                    <span class="row-title">{title(t, name)}</span>
                    <span class="row-sub">
                      {subtitle(t.transaction, name)}
                      {t.pending && <span class="mono tag">Waiting to sync</span>}
                      {t.failed && <span class="mono tag tag-bad">Not saved</span>}
                    </span>
                  </span>
                  <Share t={t.transaction} mine={mine} />
                </a>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function title(t: Shown, name: (id: string) => string): string {
  if (t.transaction.kind === 'settlement') return `${name(t.transaction.from)} paid ${name(t.transaction.to)}`;
  return t.description || 'Expense';
}

function subtitle(t: Transaction, name: (id: string) => string): string {
  if (t.kind === 'settlement') return `Payment · ${money(t.amount, t.currency)}`;
  const payers = t.paidBy.map((p) => name(p.member));
  return `${payers.join(' and ')} paid ${money(t.total, t.currency)}`;
}

/** What this means for you: lent, borrowed, or not involved. */
function Share({ t, mine }: { t: Transaction; mine: string | undefined }) {
  if (!mine) return null;
  let net = 0;
  if (t.kind === 'settlement') {
    if (t.from === mine) net = t.amount;
    else if (t.to === mine) net = -t.amount;
  } else {
    net = t.paidBy.find((p) => p.member === mine)?.amount ?? 0;
    try {
      net -= splitAmount(t.total, t.split).find((share) => share.member === mine)?.amount ?? 0;
    } catch {
      return null;
    }
  }
  if (net === 0) return <span class="share share-none">not involved</span>;
  const lent = t.kind === 'settlement' ? (net > 0 ? 'you paid' : 'you got') : net > 0 ? 'you lent' : 'you borrowed';
  return (
    <span class={`share ${net > 0 ? 'share-owed' : 'share-owe'}`}>
      <span class="mono">{lent}</span>
      <span class="amount">{money(Math.abs(net), t.currency)}</span>
    </span>
  );
}

export type { Member };
