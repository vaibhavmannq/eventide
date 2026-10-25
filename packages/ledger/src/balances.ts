import type { Minor } from './money.ts';
import type { MemberId } from './split.ts';
import type { Posting } from './transactions.ts';

/** currency → member → balance. Positive: they are owed. Negative: they owe. Zero balances are left out. */
export type Balances = Map<string, Map<MemberId, Minor>>;

/**
 * A balance is the sum of a member's postings, per currency. Currencies are never mixed: converting would
 * need an exchange rate and a moment to take it from, and that is a decision for the people settling up,
 * not something the ledger should make silently.
 */
export function balancesOf(postings: Iterable<Posting>): Balances {
  const balances: Balances = new Map();
  for (const { member, currency, amount } of postings) {
    let members = balances.get(currency);
    if (!members) {
      members = new Map();
      balances.set(currency, members);
    }
    members.set(member, (members.get(member) ?? 0) + amount);
  }
  for (const [currency, members] of balances) {
    for (const [member, amount] of members) if (amount === 0) members.delete(member);
    if (members.size === 0) balances.delete(currency);
  }
  return balances;
}
