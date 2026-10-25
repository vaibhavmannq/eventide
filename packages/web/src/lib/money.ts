import { exponentOf, type Minor } from '@eventide/ledger';

const formatters = new Map<string, Intl.NumberFormat>();

/** 1230 GBP → "£12.30", in the reader's own number style. Display only; amounts stay whole minor units. */
export function money(minor: Minor, currency: string, options: { sign?: boolean } = {}): string {
  const key = `${currency}:${options.sign ? 's' : ''}`;
  let format = formatters.get(key);
  if (!format) {
    const digits = exponentOf(currency);
    format = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      signDisplay: options.sign ? 'exceptZero' : 'auto',
    });
    formatters.set(key, format);
  }
  return format.format(minor / 10 ** exponentOf(currency));
}

/** Today in the reader's own calendar, as YYYY-MM-DD. */
export function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function longDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: y === new Date().getFullYear() ? undefined : 'numeric',
  });
}
