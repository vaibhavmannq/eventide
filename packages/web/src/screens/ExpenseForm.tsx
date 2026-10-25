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

type Mode = 'equal' | 'exact' | 'percent' | 'shares';

/** "Paid by" can be one person, or this: an amount for each of several people. */
const SEVERAL = 'several';

/**
 * "33.33" → 3333 basis points. Up to two decimals, parsed from the text so a percentage never passes through a
 * float, exactly like amounts (ADR 0002). Empty is zero; anything else that is not a percentage is null.
 */
function parsePercent(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

const percentText = (basisPoints: number) => `${(basisPoints / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

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
  const [paidBy, setPaidBy] = useState(start && start.paidBy.length > 1 ? SEVERAL : (start?.paidBy[0]?.member ?? mine));
  const [payers, setPayers] = useState<Record<string, string>>(
    start && start.paidBy.length > 1
      ? Object.fromEntries(start.paidBy.map((p) => [p.member, formatAmount(p.amount, start.currency)]))
      : {},
  );
  const [mode, setMode] = useState<Mode>(startSplit?.kind ?? 'equal');
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
  const [percents, setPercents] = useState<Record<string, string>>(
    startSplit?.kind === 'percent'
      ? Object.fromEntries(startSplit.parts.map((p) => [p.member, percentText(p.basisPoints).slice(0, -1)]))
      : {},
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
      } else if (mode === 'percent') {
        const parts: { member: string; basisPoints: number }[] = [];
        for (const m of members) {
          const basisPoints = parsePercent(percents[m.id] ?? '');
          if (basisPoints === null) return { problem: `${m.displayName}’s percentage is not a number like 33.33` };
          if (basisPoints > 0) parts.push({ member: m.id, basisPoints });
        }
        const sum = parts.reduce((a, b) => a + b.basisPoints, 0);
        if (sum < 10000) return { problem: `${percentText(10000 - sum)} still to assign` };
        if (sum > 10000) return { problem: `${percentText(sum - 10000)} over 100%` };
        split = { kind: 'percent', parts };
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
    let paid: Expense['paidBy'];
    if (paidBy === SEVERAL) {
      try {
        paid = members
          .map((m) => ({ member: m.id, amount: parseAmount(payers[m.id] || '0', currency) }))
          .filter((p) => p.amount !== 0);
      } catch {
        return { problem: 'One of the payments is not a valid amount' };
      }
      if (paid.some((p) => p.amount < 0)) return { problem: 'Payments are more than zero' };
      const left = total - paid.reduce((a, b) => a + b.amount, 0);
      if (left > 0) return { problem: `${money(left, currency)} of the payment still to assign` };
      if (left < 0) return { problem: `The payments are ${money(-left, currency)} more than the total` };
    } else {
      paid = [{ member: paidBy, amount: total }];
    }
    const transaction: Expense = { kind: 'expense', currency, total, paidBy: paid, split };
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
                <option value={SEVERAL}>Several people…</option>
              </select>
            </label>
            <label class="field">
              <span class="mono">Date</span>
              <input type="date" value={occurredOn} onInput={(e) => setOccurredOn(e.currentTarget.value)} required />
            </label>
          </div>

          {paidBy === SEVERAL && (
            <fieldset class="field">
              <legend class="mono">Who paid how much</legend>
              <ul class="split-list">
                {members.map((m) => (
                  <li key={m.id} class="split-row">
                    <span>{m.id === mine ? `${m.displayName} (you)` : m.displayName}</span>
                    <input
                      class="small-input"
                      inputMode="decimal"
                      placeholder="0.00"
                      aria-label={`${m.displayName} paid`}
                      value={payers[m.id] ?? ''}
                      onInput={(e) => setPayers({ ...payers, [m.id]: e.currentTarget.value.replace(',', '.') })}
                    />
                  </li>
                ))}
              </ul>
            </fieldset>
          )}

          <fieldset class="field">
            <legend class="mono">Split</legend>
            <div class="modes mono">
              {(['equal', 'exact', 'percent', 'shares'] as const).map((m) => (
                <label key={m} class={mode === m ? 'on' : ''}>
                  <input type="radio" name="split-mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
                  {m === 'equal' ? 'Equally' : m === 'exact' ? 'Exact' : m === 'percent' ? 'Percent' : 'Shares'}
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
                    {mode === 'percent' && (
                      <input
                        class="small-input"
                        inputMode="decimal"
                        placeholder="0"
                        aria-label={`${m.displayName}'s percentage`}
                        value={percents[m.id] ?? ''}
                        onInput={(e) => setPercents({ ...percents, [m.id]: e.currentTarget.value.replace(',', '.') })}
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
              : `${payerNames(built.transaction.paidBy.map((p) => names.get(p.member) ?? 'Someone'))} paid ${money(built.transaction.total, currency)}, split ${preview.length} ${preview.length === 1 ? 'way' : 'ways'}.`}
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

/** "Alice", "Alice and Bob", "Alice, Bob and Sam". */
function payerNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? 'Someone';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
