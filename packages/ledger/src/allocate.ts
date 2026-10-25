import { LedgerError } from './errors.ts';
import { assertMinor, type Minor } from './money.ts';

/**
 * Splits a whole-number total into whole-number parts in proportion to the weights, and the parts always
 * add up to exactly the total. £10.00 three ways is 334 + 333 + 333, not 333 + 333 + 333 with a penny lost.
 *
 * Largest remainder method: everyone gets the floor of their exact share, then the pennies left over go one
 * each to the largest fractional remainders. Ties go to the earlier weight, so the same input always gives
 * the same output. Each part is within one unit of its exact share.
 *
 * The arithmetic runs in BigInt because total × weight can pass 2^53 even when both fit in a number.
 */
export function allocate(total: Minor, weights: readonly number[]): Minor[] {
  assertMinor(total, 'total');
  if (weights.length === 0) throw new LedgerError('NO_PARTICIPANTS', 'Nothing to allocate between');
  for (const weight of weights) {
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new LedgerError('BAD_WEIGHT', `Weights must be whole numbers, zero or more: ${weight}`);
    }
  }
  const weightSum = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  if (weightSum === 0n) throw new LedgerError('BAD_WEIGHT', 'At least one weight must be more than zero');

  // A refund (negative total) splits exactly like a payment, mirrored.
  const negative = total < 0;
  const magnitude = BigInt(Math.abs(total));

  const parts = weights.map((weight) => (magnitude * BigInt(weight)) / weightSum);
  const remainders = weights.map((weight, index) => ({ index, remainder: (magnitude * BigInt(weight)) % weightSum }));

  let leftover = magnitude - parts.reduce((sum, part) => sum + part, 0n);
  remainders.sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));
  for (const { index } of remainders) {
    if (leftover === 0n) break;
    parts[index] = (parts[index] ?? 0n) + 1n;
    leftover -= 1n;
  }

  // `negative && part > 0n` rather than `negative`, so a zero part stays 0 and never becomes -0.
  return parts.map((part) => (negative && part > 0n ? -Number(part) : Number(part)));
}
