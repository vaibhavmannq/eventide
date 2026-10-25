import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CURRENCY_EXPONENTS, formatAmount, LedgerError, parseAmount } from '../src/index.ts';

describe('parseAmount', () => {
  it('reads amounts from text without going through a float', () => {
    expect(parseAmount('12.30', 'GBP')).toBe(1230);
    expect(parseAmount('0.29', 'USD')).toBe(29); // 0.29 * 100 is 28.999999999999996 in floating point
    expect(parseAmount('1.1', 'EUR')).toBe(110);
    expect(parseAmount('7', 'GBP')).toBe(700);
    expect(parseAmount('1500', 'JPY')).toBe(1500);
    expect(parseAmount('1.234', 'KWD')).toBe(1234);
    expect(parseAmount('-4.50', 'GBP')).toBe(-450);
    expect(parseAmount(' 3.00 ', 'GBP')).toBe(300);
  });

  it('refuses more decimals than the currency has, rather than rounding', () => {
    expect(() => parseAmount('1.005', 'GBP')).toThrow(expect.objectContaining({ code: 'TOO_MANY_DECIMALS' }));
    expect(() => parseAmount('10.5', 'JPY')).toThrow(expect.objectContaining({ code: 'TOO_MANY_DECIMALS' }));
  });

  it('refuses things that are not amounts', () => {
    for (const text of ['', '£5', '1,000', '1e3', '.5', '5.', 'abc', '--1']) {
      expect(() => parseAmount(text, 'GBP'), text).toThrow(LedgerError);
    }
  });

  it('refuses unknown currencies and amounts too large to add exactly', () => {
    expect(() => parseAmount('1', 'UDS')).toThrow(expect.objectContaining({ code: 'UNKNOWN_CURRENCY' }));
    expect(() => parseAmount('99999999999999999', 'GBP')).toThrow(expect.objectContaining({ code: 'UNSAFE_AMOUNT' }));
  });
});

describe('formatAmount', () => {
  it('writes minor units as a decimal', () => {
    expect(formatAmount(1230, 'GBP')).toBe('12.30');
    expect(formatAmount(5, 'GBP')).toBe('0.05');
    expect(formatAmount(-450, 'GBP')).toBe('-4.50');
    expect(formatAmount(0, 'GBP')).toBe('0.00');
    expect(formatAmount(1500, 'JPY')).toBe('1500');
    expect(formatAmount(1, 'KWD')).toBe('0.001');
  });

  it('round-trips through parseAmount for every currency', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(CURRENCY_EXPONENTS)),
        fc.integer({ min: -1e12, max: 1e12 }),
        (currency, minor) => {
          expect(parseAmount(formatAmount(minor, currency), currency)).toBe(minor);
        },
      ),
    );
  });
});
