import { LedgerError } from './errors.ts';
import type { Minor } from './money.ts';
import type { MemberId } from './split.ts';

/** `from` should pay `to` this much. */
export interface Transfer {
  from: MemberId;
  to: MemberId;
  amount: Minor;
}

/**
 * Up to this many people with a non-zero balance, settleUp finds the true minimum number of payments.
 * The exact search costs 2^n × n steps: 15 people is about half a million, which measured well inside a
 * Cloudflare Worker's 10 ms CPU budget (docs/DESIGN.md §5.5). Above it, the greedy answer is used.
 */
export const EXACT_LIMIT = 15;

interface Entry {
  member: MemberId;
  amount: Minor;
}

/**
 * The payments that bring every balance in one currency to zero, using as few payments as possible.
 *
 * Any group of n people with non-zero balances can settle in n − 1 payments. It can do better when it splits
 * into smaller groups whose balances already cancel out: each group of k needs only k − 1 payments, so
 * the minimum is n minus the largest number of zero-sum groups the balances can be divided into.
 * Finding that is NP-hard in general (it contains the subset-sum problem), so it is searched exactly for up
 * to EXACT_LIMIT people and approximated above that.
 */
export function settleUp(balances: ReadonlyMap<MemberId, Minor>, exactLimit = EXACT_LIMIT): Transfer[] {
  const entries: Entry[] = [];
  let sum = 0;
  let magnitude = 0;
  for (const [member, amount] of balances) {
    sum += amount;
    magnitude += Math.abs(amount);
    if (amount !== 0) entries.push({ member, amount });
  }
  if (!Number.isSafeInteger(magnitude)) throw new LedgerError('UNSAFE_AMOUNT', 'Balances are too large to settle');
  if (sum !== 0) throw new LedgerError('UNBALANCED', `Balances add up to ${sum}, not zero`);
  entries.sort((a, b) => (a.member < b.member ? -1 : a.member > b.member ? 1 : 0));

  const groups = entries.length <= exactLimit ? zeroSumGroups(entries) : [entries];
  return groups.flatMap(greedy).sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to));
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Divides the entries into as many zero-sum groups as possible, by dynamic programming over subsets.
 *
 * best[mask] is the most zero-sum groups that the members in `mask` can be cut into when they are taken one
 * at a time in some order and a group is closed whenever the running total reaches zero. Any division into
 * zero-sum groups is reachable that way (list each group's members together), so best[all] is the true
 * maximum. Walking back through the masks recovers an order, and the zero points along it are the groups.
 */
function zeroSumGroups(entries: readonly Entry[]): Entry[][] {
  const n = entries.length;
  const size = 1 << n;
  const sums = new Float64Array(size);
  const best = new Int8Array(size);

  for (let mask = 1; mask < size; mask++) {
    const low = 31 - Math.clz32(mask & -mask);
    sums[mask] = (sums[mask & (mask - 1)] ?? 0) + (entries[low]?.amount ?? 0);
    let most = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) most = Math.max(most, best[mask ^ (1 << i)] ?? 0);
    }
    best[mask] = most + (sums[mask] === 0 ? 1 : 0);
  }

  const groups: Entry[][] = [];
  let group: Entry[] = [];
  let mask = size - 1;
  while (mask !== 0) {
    const closes = sums[mask] === 0 ? 1 : 0;
    for (let i = 0; i < n; i++) {
      const bit = 1 << i;
      if (mask & bit && (best[mask ^ bit] ?? 0) + closes === best[mask]) {
        const entry = entries[i];
        if (entry) group.push(entry);
        mask ^= bit;
        break;
      }
    }
    if (sums[mask] === 0) {
      groups.push(group);
      group = [];
    }
  }
  return groups;
}

/**
 * Settles one zero-sum group in at most k − 1 payments: the person owed most is paid by the person who owes
 * most, as much as one of them needs, and every payment clears at least one of the two (the last clears
 * both). Ties go to the earlier member, so the answer is stable.
 */
function greedy(group: readonly Entry[]): Transfer[] {
  const creditors = group.filter((entry) => entry.amount > 0).map((entry) => ({ ...entry }));
  const debtors = group.filter((entry) => entry.amount < 0).map((entry) => ({ ...entry, amount: -entry.amount }));
  const transfers: Transfer[] = [];

  const largest = (list: Entry[]) => {
    let top: Entry | undefined;
    for (const entry of list) if (entry.amount > 0 && (!top || entry.amount > top.amount)) top = entry;
    return top;
  };

  for (;;) {
    const creditor = largest(creditors);
    const debtor = largest(debtors);
    if (!creditor || !debtor) break;
    const amount = Math.min(creditor.amount, debtor.amount);
    transfers.push({ from: debtor.member, to: creditor.member, amount });
    creditor.amount -= amount;
    debtor.amount -= amount;
  }
  return transfers;
}
