/**
 * End-to-end check against a running Eventide, over real HTTP: sign in, create a group, record an expense
 * (twice, with the same key), read balances and the feed, sign out. Uses the development login, so it runs
 * against `npm run dev` (or any deployment with DEV_LOGIN on, which production never has).
 *
 * Run: node --experimental-strip-types scripts/smoke.ts http://localhost:8787
 */
export {};

const base = process.argv[2] ?? 'http://localhost:8787';
let cookie = '';

async function call(method: string, path: string, body?: unknown, key?: string) {
  const headers: Record<string, string> = { Origin: new URL(base).origin };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const started = performance.now();
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? null : JSON.stringify(body),
  });
  const ms = Math.round(performance.now() - started);
  const set = response.headers.getSetCookie().find((c) => c.startsWith('__Host-session='));
  if (set) cookie = set.split(';')[0] ?? '';
  const text = await response.text();
  console.log(`${method.padEnd(6)} ${path.padEnd(60)} ${response.status}  ${ms} ms`);
  if (!response.ok) throw new Error(text);
  return response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
}

const page = await call('GET', '/');
if (!String(page).includes('<title>Eventide</title>')) throw new Error('The app page was not served');
await call('GET', '/api/health');
await call('POST', '/api/auth/dev', { email: `smoke-${Date.now()}@example.com`, name: 'Smoke' });
const { group } = await call('POST', '/api/groups', { name: 'Smoke test', currency: 'GBP', displayName: 'Me' });
const { member } = await call('POST', `/api/groups/${group.id}/members`, { displayName: 'Friend' });
const me = group.members[0].id;

const key = crypto.randomUUID();
const expense = {
  id: crypto.randomUUID(),
  description: 'Dinner',
  occurredOn: new Date().toISOString().slice(0, 10),
  transaction: {
    kind: 'expense',
    currency: 'GBP',
    total: 1000,
    paidBy: [{ member: me, amount: 1000 }],
    split: { kind: 'equal', members: [me, member.id] },
  },
};
const first = await call('POST', `/api/groups/${group.id}/transactions`, expense, key);
const retry = await call('POST', `/api/groups/${group.id}/transactions`, expense, key);
if (JSON.stringify(first) !== JSON.stringify(retry)) throw new Error('A retry gave a different answer');

const { currencies } = await call('GET', `/api/groups/${group.id}/balances`);
if (currencies.GBP.balances[me] !== 500) throw new Error(`Unexpected balance: ${JSON.stringify(currencies)}`);
const { changes } = await call('GET', `/api/groups/${group.id}/changes`);
if (changes.length !== 1) throw new Error(`Expected one change, got ${changes.length}`);
await call('POST', '/api/auth/logout');
console.log('\nAll good.');
