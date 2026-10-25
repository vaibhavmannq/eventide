import { LedgerError } from './errors.ts';
import { assertPositiveMinor, exponentOf, type Minor } from './money.ts';
import { type MemberId, type Share, type SplitSpec, splitAmount } from './split.ts';

/** Someone paid for something, and some people owe their part of it. */
export interface Expense {
  kind: 'expense';
  currency: string;
  total: Minor;
  /** Who paid, and how much each. Usually one person; a dinner can be paid by two cards. */
  paidBy: readonly Share[];
  split: SplitSpec;
}

/** Money changed hands to pay back a debt: `from` paid `to`. */
export interface Settlement {
  kind: 'settlement';
  currency: string;
  from: MemberId;
  to: MemberId;
  amount: Minor;
}

export type Transaction = Expense | Settlement;

/**
 * One line of the ledger: how one transaction moved one member's balance. Positive means the group owes
 * them more; negative means they owe the group more.
 */
export interface Posting {
  member: MemberId;
  currency: string;
  amount: Minor;
}

/**
 * Double-entry: every transaction becomes postings that add up to exactly zero. Money is never created or
 * lost, only moved between members, so the sum of every balance in a group is always zero. The database
 * checks the same rule again when the postings are written (docs/DESIGN.md §5.3).
 *
 * A member's posting is what they paid minus what they owe. Members with a net of zero get no posting.
 */
export function toPostings(transaction: Transaction): Posting[] {
  exponentOf(transaction.currency);
  const net = new Map<MemberId, Minor>();
  const add = (member: MemberId, amount: Minor) => net.set(member, (net.get(member) ?? 0) + amount);

  if (transaction.kind === 'expense') {
    assertPositiveMinor(transaction.total, 'total');
    if (transaction.paidBy.length === 0) throw new LedgerError('PAYERS_MISMATCH', 'Someone has to have paid');
    let paid = 0;
    const payers = new Set<MemberId>();
    for (const payer of transaction.paidBy) {
      if (payers.has(payer.member)) {
        throw new LedgerError('DUPLICATE_MEMBER', `${payer.member} is listed twice as a payer`);
      }
      payers.add(payer.member);
      assertPositiveMinor(payer.amount, `${payer.member}'s payment`);
      paid += payer.amount;
      add(payer.member, payer.amount);
    }
    if (paid !== transaction.total) {
      throw new LedgerError(
        'PAYERS_MISMATCH',
        `The payments add up to ${paid}, but the expense is ${transaction.total}`,
      );
    }
    for (const share of splitAmount(transaction.total, transaction.split)) add(share.member, -share.amount);
  } else {
    assertPositiveMinor(transaction.amount);
    if (transaction.from === transaction.to) throw new LedgerError('SELF_SETTLEMENT', 'Nobody can pay themselves back');
    // Paying someone back raises your balance and lowers theirs: you owe less, they are owed less.
    add(transaction.from, transaction.amount);
    add(transaction.to, -transaction.amount);
  }

  const postings = [...net]
    .filter(([, amount]) => amount !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([member, amount]) => ({ member, currency: transaction.currency, amount }));
  assertBalanced(postings);
  return postings;
}

/**
 * Editing or deleting never rewrites history: it appends the reverse of the old postings (and, for an edit,
 * the new ones). The ledger only grows, so every balance can be explained line by line.
 */
export function reversePostings(postings: readonly Posting[]): Posting[] {
  return postings.map(({ member, currency, amount }) => ({ member, currency, amount: -amount }));
}

/** The double-entry rule: per currency, postings add up to zero. */
export function assertBalanced(postings: readonly Posting[]): void {
  const sums = new Map<string, number>();
  for (const posting of postings) sums.set(posting.currency, (sums.get(posting.currency) ?? 0) + posting.amount);
  for (const [currency, sum] of sums) {
    if (sum !== 0) throw new LedgerError('UNBALANCED', `${currency} postings add up to ${sum}, not zero`);
  }
}
