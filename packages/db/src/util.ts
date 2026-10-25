import type { Minor } from '@eventide/ledger';

/** Postgres sends bigint and numeric as text. */
export function minor(text: string): Minor {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error(`Amount out of range: ${text}`);
  return value;
}

export function one<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('Expected a row');
  return row;
}

/** JSON with object keys sorted, so the same request always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** A random token for a cookie or a link: 32 bytes, base64url. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
