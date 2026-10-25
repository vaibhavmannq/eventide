import {
  type Expense,
  formatAmount,
  LedgerError,
  parseAmount,
  type SplitSpec,
  splitAmount,
  type Transaction,
  toPostings,
} from '@eventide/ledger';
import { useState } from 'preact/hooks';
import { Header } from '../components/Header.tsx';
import { currencies } from '../lib/currency.ts';
import { money, today } from '../lib/money.ts';
import { go } from '../lib/router.ts';
import { edit, groups, myMemberId, record, remove, shownTransactions } from '../lib/store.ts';

type Mode = 'equal' | 'exact' | 'shares';

/** Adding or editing an expense; editing a payment shows it read-only with a delete button. */
export function ExpenseForm({ groupId, transactionId }: { groupId: string; transactionId?: string }) {
  const cache = groups.value[groupId];
  const existing = transactionId ? shownTransactions(groupId).find((t) => t.id === transactionId) : undefined;
  if (!cache || (transactionId && !existing)) {
    return (
      <>
        <Header back={{ to: `/groups/${groupId}`, label: 'Back' }} />
        <main class="page narrow">
          <p class="muted">{cache ? 'This expense no longer exists.' : 'Loading…'}</p>
        </main>
      </>
    );
  }
  if (existing?.transaction.kind === 'settlement') return <PaymentView groupId={groupId} id={existing.id} />;
  return (
    <Form
      groupId={groupId}
      existing={existing as (typeof existing & { transaction: Expense }) | undefined}
      key={transactionId ?? 'new'}
    />
  );
}

function Form({
  groupId,
  existing,
}: {
  groupId: string;
  existing?: { id: string; description: string; occurredOn: string; transaction: Expense } & Parameters<typeof edit>[0];
}) {
  const cache = groups.value[groupId];
  const start0 = existing?.transaction;
  // Current members, plus anyone who has since left but is part of the expense being edited.
  const named = new Set(start0 ? [...start0.paidBy.map((p) => p.member), ...splitMembers(start0.split)] : []);
  const members = (cache?.group.members ?? []).filter((m) => !m.leftAt || named.has(m.id));
  const mine = myMemberId(cache?.group) ?? members[0]?.id ?? '';
  const start = existing?.transaction;
  const startSplit = start?.split;

  const [currency, setCurrency] = useState(start?.currency ?? cache?.group.defaultCurrency ?? 'GBP');
  const [amount, setAmount] = useState(start ? formatAmount(start.total, start.currency) : '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [occurredOn, setOccurredOn] = useState(existing?.occurredOn ?? today());
  const [paidBy, setPaidBy] = useState(start?.paidBy.length === 1 ? (start.paidBy[0]?.member ?? mine) : mine);
  const [mode, setMode] = useState<Mode>(
    startSplit?.kind === 'exact' ? 'exact' : startSplit?.kind === 'shares' ? 'shares' : 'equal',
  );
  const [included, setIncluded] = useState<Set<string>>(
    new Set(startSplit?.kind === 'equal' ? startSplit.members : members.map((m) => m.id)),
  );
  const [exact, setExact] = useState<Record<string, string>>(
    startSplit?.kind === 'exact'
      ? Object.fromEntries(startSplit.amounts.map((a) => [a.member, formatAmount(a.amount, currency)]))
      : {},
  );
  const [shares, setShares] = useState<Record<string, string>>(
    startSplit?.kind === 'shares'
      ? Object.fromEntries(startSplit.parts.map((p) => [p.member, String(p.weight)]))
      : Object.fromEntries(members.map((m) => [m.id, '1'])),
  );
  const [error, setError] = useState('');

  /** The expense as typed so far, or the reason it is not valid yet. */
  function build(): { transaction: Expense } | { problem: string } {
    let total: number;
    try {
      total = parseAmount(amount || '0', currency);
    } catch (e) {
      return { problem: e instanceof LedgerError && e.code === 'TOO_MANY_DECIMALS' ? e.message : 'Enter an amount' };
    }
    if (total <= 0) return { problem: 'Enter an amount' };
    let split: SplitSpec;
    try {
      if (mode === 'equal') {
        if (included.size === 0) return { problem: 'Pick at least one person to split with' };
        split = { kind: 'equal', members: members.filter((m) => included.has(m.id)).map((m) => m.id) };
      } else if (mode === 'exact') {
        split = {
          kind: 'exact',
          amounts: members
            .map((m) => ({ member: m.id, amount: parseAmount(exact[m.id] || '0', currency) }))
            .filter((a) => a.amount !== 0),
        };
      } else {
        const parts = members
          .map((m) => ({ member: m.id, weight: Number(shares[m.id] || 0) }))
          .filter((p) => p.weight > 0);
        if (parts.some((p) => !Number.isInteger(p.weight))) return { problem: 'Shares are whole numbers' };
        split = { kind: 'shares', parts };
      }
    } catch {
      return { problem: 'One of the amounts is not a valid number' };
    }
    const transaction: Expense = {
      kind: 'expense',
      currency,
      total,
      paidBy: [{ member: paidBy, amount: total }],
      split,
    };
    try {
      toPostings(transaction);
    } catch (e) {
      if (e instanceof LedgerError && e.code === 'SPLIT_MISMATCH' && split.kind === 'exact') {
        const sum = split.amounts.reduce((a, b) => a + b.amount, 0);
        const left = total - sum;
        return {
          problem:
            left > 0 ? `${money(left, currency)} still to assign` : `${money(-left, currency)} more than the total`,
        };
      }
      return { problem: e instanceof Error ? e.message : 'Not valid yet' };
    }
    return { transaction };
  }

  const built = build();
  const preview = 'transaction' in built ? splitAmount(built.transaction.total, built.transaction.split) : [];
  const names = new Map(members.map((m) => [m.id, m.displayName]));
  const back = `/groups/${groupId}`;

  async function save(e: Event) {
    e.preventDefault();
    if (!('transaction' in built)) {
      setError(built.problem);
      return;
    }
    const details = { description: description.trim(), occurredOn, transaction: built.transaction as Transaction };
    if (existing) await edit(existing, details);
    else await record(groupId, details);
    go(back);
  }

  return (
    <>
      <Header back={{ to: back, label: cache?.group.name ?? 'Back' }} />
      <main class="page narrow">
        <p class="mono label">{existing ? 'Edit expense' : 'New expense'}</p>
        <form class="form" onSubmit={save} noValidate>
          <div class="amount-row">
            <label class="field amount-field">
              <span class="mono">Amount</span>
              <input
                class="amount-input"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                value={amount}
                onInput={(e) => setAmount(e.currentTarget.value.replace(',', '.'))}
                aria-describedby="form-problem"
              />
            </label>
            <label class="field currency-field">
              <span class="mono">Currency</span>
              <select value={currency} onChange={(e) => setCurrency(e.currentTarget.value)}>
                {currencies.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label class="field">
            <span class="mono">What for</span>
            <input
              value={description}
              onInput={(e) => setDescription(e.currentTarget.value)}
              placeholder="Groceries, dinner, rent…"
              maxLength={200}
            />
          </label>

          <div class="two">
            <label class="field">
              <span class="mono">Paid by</span>
              <select value={paidBy} onChange={(e) => setPaidBy(e.currentTarget.value)}>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id === mine ? `${m.displayName} (you)` : m.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label class="field">
              <span class="mono">Date</span>
              <input type="date" value={occurredOn} onInput={(e) => setOccurredOn(e.currentTarget.value)} required />
            </label>
          </div>

          <fieldset class="field">
            <legend class="mono">Split</legend>
            <div class="modes mono">
              {(['equal', 'exact', 'shares'] as const).map((m) => (
                <label key={m} class={mode === m ? 'on' : ''}>
                  <input type="radio" name="split-mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
                  {m === 'equal' ? 'Equally' : m === 'exact' ? 'Exact' : 'Shares'}
                </label>
              ))}
            </div>

            <ul class="split-list">
              {members.map((m) => {
                const share = preview.find((p) => p.member === m.id)?.amount;
                return (
                  <li key={m.id} class="split-row">
                    {mode === 'equal' ? (
                      <label class="check">
                        <input
                          type="checkbox"
                          checked={included.has(m.id)}
                          onChange={(e) => {
                            const next = new Set(included);
                            if (e.currentTarget.checked) next.add(m.id);
                            else next.delete(m.id);
                            setIncluded(next);
                          }}
                        />
                        <span>{m.displayName}</span>
                      </label>
                    ) : (
                      <span>{m.displayName}</span>
                    )}
                    {mode === 'exact' && (
                      <input
                        class="small-input"
                        inputMode="decimal"
                        placeholder="0.00"
                        aria-label={`${m.displayName}'s amount`}
                        value={exact[m.id] ?? ''}
                        onInput={(e) => setExact({ ...exact, [m.id]: e.currentTarget.value.replace(',', '.') })}
                      />
                    )}
                    {mode === 'shares' && (
                      <input
                        class="small-input"
                        inputMode="numeric"
                        aria-label={`${m.displayName}'s shares`}
                        value={shares[m.id] ?? ''}
                        onInput={(e) => setShares({ ...shares, [m.id]: e.currentTarget.value })}
                      />
                    )}
                    <span class="amount muted share-preview">{share ? money(share, currency) : '—'}</span>
                  </li>
                );
              })}
            </ul>
          </fieldset>

          <p id="form-problem" class={error ? 'notice notice-bad' : 'muted small'} role={error ? 'alert' : undefined}>
            {'problem' in built
              ? error || built.problem
              : `${names.get(paidBy) ?? 'Someone'} paid ${money(built.transaction.total, currency)}, split ${preview.length} ${preview.length === 1 ? 'way' : 'ways'}.`}
          </p>

          <div class="actions">
            <button class="pill pill-solid" type="submit">
              {existing ? 'Save changes' : 'Add expense'}
            </button>
            {existing && (
              <button
                class="pill pill-danger"
                type="button"
                onClick={async () => {
                  if (!confirm('Delete this expense? Everyone’s balances will update.')) return;
                  await remove(existing);
                  go(back);
                }}
              >
                Delete
              </button>
            )}
          </div>
        </form>
      </main>
    </>
  );
}

function PaymentView({ groupId, id }: { groupId: string; id: string }) {
  const cache = groups.value[groupId];
  const t = shownTransactions(groupId).find((x) => x.id === id);
  if (!cache || !t || t.transaction.kind !== 'settlement') return null;
  const names = new Map(cache.group.members.map((m) => [m.id, m.displayName]));
  const back = `/groups/${groupId}`;
  return (
    <>
      <Header back={{ to: back, label: cache.group.name }} />
      <main class="page narrow">
        <p class="mono label">Payment</p>
        <h1 class="title">
          {names.get(t.transaction.from)} paid {names.get(t.transaction.to)}{' '}
          {money(t.transaction.amount, t.transaction.currency)}
        </h1>
        <p class="muted">Recorded for {t.occurredOn}. If it was a mistake, delete it and the balances go back.</p>
        <div class="actions">
          <button
            class="pill pill-danger"
            type="button"
            onClick={async () => {
              if (!confirm('Delete this payment?')) return;
              await remove(t);
              go(back);
            }}
          >
            Delete payment
          </button>
        </div>
      </main>
    </>
  );
}

function splitMembers(split: SplitSpec): string[] {
  if (split.kind === 'equal') return [...split.members];
  if (split.kind === 'exact') return split.amounts.map((a) => a.member);
  return split.parts.map((p) => p.member);
}
