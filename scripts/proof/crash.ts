/**
 * The crash test (docs/DESIGN.md §12): writers keep adding expenses to one group while the server is killed with
 * SIGKILL again and again, mid-request and mid-transaction. Each writer retries every request with the same
 * Idempotency-Key until it gets an answer, exactly as the app's outbox does.
 *
 * Passes only if, at the end: every expense is in the ledger exactly once (none lost, none doubled), every
 * retry got the same answer as the first success, and the ledger audit finds nothing.
 *
 *   node --experimental-strip-types scripts/proof/crash.ts [writers] [expensesEach] [kills]
 */
import { expense, freshDatabase, makeGroup, Person, startServer } from './harness.ts';

const WRITERS = Number(process.argv[2] ?? 20);
const EACH = Number(process.argv[3] ?? 40);
const KILLS = Number(process.argv[4] ?? 15);

const db = await freshDatabase('eventide_crash');
const server = await startServer(db.appUrl, 8791);
let failed = false;

try {
  const people = await Promise.all(
    Array.from({ length: WRITERS }, (_, i) => new Person(server.base, `Writer${i}`).signIn()),
  );
  const { groupId, members } = await makeGroup(people, 'Crash test');

  let retries = 0;
  let kills = 0;
  let writing = true;
  const answers = new Map<string, string>(); // key → the body of its first 201

  const writers = people.map(async (person, w) => {
    for (let i = 0; i < EACH; i++) {
      const key = crypto.randomUUID();
      const body = expense(members, members[w] ?? '', 100 + ((w * EACH + i) % 900));
      for (;;) {
        try {
          const { status, json } = await person.call('POST', `/groups/${groupId}/transactions`, body, key);
          if (status === 201) {
            const text = JSON.stringify(json);
            const earlier = answers.get(key);
            if (earlier && earlier !== text) throw new Error(`A retry of ${key} got a different answer`);
            answers.set(key, text);
            break;
          }
          if (status < 500) throw new Error(`Refused with ${status}: ${JSON.stringify(json)}`);
        } catch (error) {
          if (!(error instanceof TypeError)) throw error; // TypeError: the connection died; retry
        }
        retries++;
        await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 30));
      }
    }
  });

  const killer = (async () => {
    while (writing && kills < KILLS) {
      await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 350));
      if (!writing) break;
      await server.crashAndRestart();
      kills++;
    }
  })();

  await Promise.all(writers);
  writing = false;
  await killer;

  const expected = WRITERS * EACH;
  const counts = await db.owner.query<{ transactions: number; entries: number; keys: number }>(`
    select (select count(*)::int from transactions) as transactions,
           (select count(*)::int from entries) as entries,
           (select count(*)::int from idempotency_keys) as keys`);
  const audit = await db.owner.query('select * from audit_ledger()');
  const total = await db.owner.query<{ sum: string }>('select coalesce(sum(amount), 0)::text as sum from postings');
  const row = counts.rows[0];

  const checks: [string, boolean][] = [
    [`${expected} expenses sent, ${row?.transactions} in the ledger`, row?.transactions === expected],
    [`one entry per expense (${row?.entries})`, row?.entries === expected],
    [`one stored answer per key (${row?.keys})`, row?.keys === expected],
    ['every retry got the same answer as the first success', answers.size === expected],
    ['the ledger audit finds nothing', audit.rows.length === 0],
    ['all postings sum to zero', total.rows[0]?.sum === '0'],
  ];
  console.log(
    `\nCrash test: ${WRITERS} writers × ${EACH} expenses, server killed ${kills} times, ${retries} retries\n`,
  );
  for (const [what, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${what}`);
    if (!ok) failed = true;
  }
  console.log(failed ? '\nFAILED' : '\nPASSED: 0 lost, 0 duplicated');
} finally {
  await server.stop().catch(() => {});
  await db.drop();
}
process.exit(failed ? 1 : 0);
