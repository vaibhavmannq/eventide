import { allocate } from './allocate.ts';
import { LedgerError } from './errors.ts';
import { assertMinor, type Minor } from './money.ts';

export type MemberId = string;

/** One person's part of an amount. */
export interface Share {
  member: MemberId;
  amount: Minor;
}

/**
 * How an expense is divided, as the person entering it described it. Stored as given, so the expense can be
 * shown and edited the way it was entered; the amounts are always derived from it by splitAmount.
 */
export type SplitSpec =
  | { kind: 'equal'; members: readonly MemberId[] }
  | { kind: 'exact'; amounts: readonly Share[] }
  /** Basis points: 10000 is 100%, so 33.33% is 3333 and percentages never need a float. */
  | { kind: 'percent'; parts: readonly { member: MemberId; basisPoints: number }[] }
  /** "Alex had 2 drinks, Sam had 1": weights, not percentages. */
  | { kind: 'shares'; parts: readonly { member: MemberId; weight: number }[] };

const byMember = (a: { member: MemberId }, b: { member: MemberId }) =>
  a.member < b.member ? -1 : a.member > b.member ? 1 : 0;

function assertUnique(members: readonly MemberId[]): void {
  const seen = new Set<MemberId>();
  for (const member of members) {
    if (seen.has(member)) throw new LedgerError('DUPLICATE_MEMBER', `${member} appears twice in one split`);
    seen.add(member);
  }
}

/**
 * Turns a split into exact amounts that add up to the total, sorted by member. Sorting first means the
 * order the app happened to send the members in never changes who gets the odd penny.
 */
export function splitAmount(total: Minor, spec: SplitSpec): Share[] {
  assertMinor(total, 'total');

  switch (spec.kind) {
    case 'equal': {
      if (spec.members.length === 0) throw new LedgerError('NO_PARTICIPANTS', 'An expense needs someone to split it');
      assertUnique(spec.members);
      const members = [...spec.members].sort();
      const amounts = allocate(
        total,
        members.map(() => 1),
      );
      return members.map((member, index) => ({ member, amount: amounts[index] ?? 0 }));
    }

    case 'exact': {
      if (spec.amounts.length === 0) throw new LedgerError('NO_PARTICIPANTS', 'An expense needs someone to split it');
      assertUnique(spec.amounts.map((share) => share.member));
      let sum = 0;
      for (const share of spec.amounts) {
        assertMinor(share.amount, `${share.member}'s amount`);
        sum += share.amount;
      }
      if (sum !== total) {
        throw new LedgerError('SPLIT_MISMATCH', `The amounts add up to ${sum}, but the expense is ${total}`);
      }
      return [...spec.amounts].map(({ member, amount }) => ({ member, amount })).sort(byMember);
    }

    case 'percent': {
      const parts = [...spec.parts].sort(byMember);
      const sum = parts.reduce((total, part) => total + part.basisPoints, 0);
      if (parts.length > 0 && sum !== 10000) {
        throw new LedgerError('SPLIT_MISMATCH', `The percentages add up to ${sum / 100}%, not 100%`);
      }
      return weighted(
        total,
        parts.map(({ member, basisPoints }) => ({ member, weight: basisPoints })),
      );
    }

    case 'shares':
      return weighted(total, [...spec.parts].sort(byMember));
  }
}

function weighted(total: Minor, parts: readonly { member: MemberId; weight: number }[]): Share[] {
  if (parts.length === 0) throw new LedgerError('NO_PARTICIPANTS', 'An expense needs someone to split it');
  assertUnique(parts.map((part) => part.member));
  const amounts = allocate(
    total,
    parts.map((part) => part.weight),
  );
  return parts.map(({ member }, index) => ({ member, amount: amounts[index] ?? 0 }));
}
