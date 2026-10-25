import type { CurrencySummary, Shown } from './store.ts';

/**
 * How settled a group is, from 0 to 1, for the moon: 1 minus what is still owed over everything ever spent.
 * Full (1) only when every balance is zero; otherwise kept between a thin crescent and a gibbous moon, so it
 * never looks full while anyone still owes anything.
 */
export function settledness(summaries: CurrencySummary[], shown: Shown[]): number {
  const owed = summaries.reduce(
    (sum, s) => sum + [...s.balances.values()].filter((v) => v > 0).reduce((a, b) => a + b, 0),
    0,
  );
  if (owed === 0) return 1;
  const spent = shown.reduce((sum, t) => sum + (t.transaction.kind === 'expense' ? t.transaction.total : 0), 0);
  const fraction = spent > 0 ? 1 - owed / spent : 0;
  return Math.min(0.85, Math.max(0.12, fraction));
}
