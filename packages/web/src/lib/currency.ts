import { CURRENCY_EXPONENTS } from '@eventide/ledger';

let names: Intl.DisplayNames | undefined;
try {
  names = new Intl.DisplayNames(undefined, { type: 'currency' });
} catch {
  names = undefined;
}

/** Every currency the ledger accepts, as "INR · Indian Rupee", so the list is readable and not only codes. */
export const currencies = Object.keys(CURRENCY_EXPONENTS).map((code) => ({
  code,
  label: names ? `${code} · ${names.of(code) ?? code}` : code,
}));
