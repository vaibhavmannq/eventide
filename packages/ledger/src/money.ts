import { LedgerError } from './errors.ts';

/**
 * Money is a whole number of the currency's smallest unit (pence, cents, yen), never a float:
 * 0.1 + 0.2 !== 0.3 in floating point, and a ledger that is off by a fraction of a penny is wrong.
 * See docs/decisions/0002-integer-minor-units.md.
 */
export type Minor = number;

/**
 * Digits after the decimal point, from ISO 4217. Only currencies listed here are accepted, so a typo
 * like "UDS" fails loudly instead of being stored. Add a currency by adding a line.
 */
export const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  AED: 2,
  AUD: 2,
  BHD: 3,
  BRL: 2,
  CAD: 2,
  CHF: 2,
  CNY: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  IDR: 2,
  INR: 2,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  MXN: 2,
  NZD: 2,
  SAR: 2,
  SEK: 2,
  SGD: 2,
  THB: 2,
  USD: 2,
  VND: 0,
  ZAR: 2,
};

export function exponentOf(currency: string): number {
  const exponent = CURRENCY_EXPONENTS[currency];
  if (exponent === undefined) throw new LedgerError('UNKNOWN_CURRENCY', `Unknown currency: ${currency}`);
  return exponent;
}

/** Throws unless the value is a whole number small enough to add up exactly in a JavaScript number. */
export function assertMinor(value: number, what = 'amount'): void {
  if (!Number.isInteger(value)) throw new LedgerError('NOT_AN_INTEGER', `${what} must be a whole number: ${value}`);
  if (!Number.isSafeInteger(value)) throw new LedgerError('UNSAFE_AMOUNT', `${what} is too large: ${value}`);
}

export function assertPositiveMinor(value: number, what = 'amount'): void {
  assertMinor(value, what);
  if (value <= 0) throw new LedgerError('NON_POSITIVE_AMOUNT', `${what} must be more than zero: ${value}`);
}

const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * "12.30" in GBP → 1230. Parsed from the text, never through a float, so "0.29" is 29 and not 28.999….
 * Rejects more decimals than the currency has ("1.005" GBP) rather than rounding money someone typed.
 */
export function parseAmount(text: string, currency: string): Minor {
  const exponent = exponentOf(currency);
  const match = DECIMAL.exec(text.trim());
  if (!match) throw new LedgerError('BAD_DECIMAL', `Not an amount: "${text}"`);
  const [, sign, whole = '', fraction = ''] = match;
  if (fraction.length > exponent) {
    throw new LedgerError('TOO_MANY_DECIMALS', `${currency} has ${exponent} decimal places: "${text}"`);
  }
  const minor = Number(whole + fraction.padEnd(exponent, '0'));
  assertMinor(minor);
  return sign ? -minor : minor;
}

/** 1230 GBP → "12.30". The inverse of parseAmount; display formatting (symbols, grouping) is the UI's job. */
export function formatAmount(minor: Minor, currency: string): string {
  assertMinor(minor);
  const exponent = exponentOf(currency);
  const digits = Math.abs(minor)
    .toString()
    .padStart(exponent + 1, '0');
  const sign = minor < 0 ? '-' : '';
  if (exponent === 0) return sign + digits;
  return `${sign}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}
