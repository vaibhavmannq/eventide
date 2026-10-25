/**
 * The load test (docs/DESIGN.md §12): many people using Eventide at once, at rising concurrency, against the API
 * on Node and a local Postgres. Each simulated person loops: 4 in 5 requests read (balances, or the change feed),
 * 1 in 5 adds an expense to their group. Then the worst case: everyone writing to the same group at once, where
 * every write waits for the group's row lock (§7).
 *
 * Prints a Markdown table for docs/PERFORMANCE.md.
 *
 *   node --experimental-strip-types scripts/proof/load.ts [secondsPerStep]
 */
import { cpus } from 'node:os';
import { expense, freshDatabase, makeGroup, Person, percentile, startServer } from './harness.ts';

const SECONDS = Number(process.argv[2] ?? 15);
const HOT_ONLY = process.argv.includes('--hot');
const STEPS = HOT_ONLY ? [] : [1, 10, 25, 50, 100];
const GROUP_SIZE = 4;

const db = await freshDatabase('eventide_load');
const server = await startServer(db.appUrl, 8792, 20);

interface Sample {
  kind: 'read' | 'write';
  ms: number;
  ok: boolean;
}

async function run(
  people: { person: Person; groupId: string; members: string[]; me: string }[],
  seconds: number,
  writeShare: number,
) {
  const samples: Sample[] = [];
  const until = Date.now() + seconds * 1000;
  await Promise.all(
    people.map(async ({ person, groupId, members, me }) => {
      let turn = 0;
      while (Date.now() < until) {
        const write = Math.random() < writeShare;
        const started = performance.now();
        let ok = false;
        try {
          const response = write
            ? await person.call(
                'POST',
                `/groups/${groupId}/transactions`,
                expense(members, me, 100 + Math.floor(Math.random() * 10_000)),
                crypto.randomUUID(),
              )
            : await person.call('GET', turn++ % 2 ? `/groups/${groupId}/balances` : `/groups/${groupId}/changes`);
          ok = response.status < 400;
        } catch {
          ok = false;
        }
        samples.push({ kind: write ? 'write' : 'read', ms: performance.now() - started, ok });
      }
    }),
  );
  return samples;
}

function row(label: string, samples: Sample[], seconds: number, cpuMs: number) {
  const ms = (kind: Sample['kind']) =>
    samples
      .filter((s) => s.kind === kind)
      .map((s) => s.ms)
      .sort((a, b) => a - b);
  const reads = ms('read');
  const writes = ms('write');
  const errors = samples.filter((s) => !s.ok).length;
  const f = (n: number) => n.toFixed(0);
  return `| ${label} | ${f(samples.length / seconds)} | ${(cpuMs / samples.length).toFixed(2)} | ${f(percentile(reads, 50))} / ${f(percentile(reads, 95))} / ${f(percentile(reads, 99))} | ${f(percentile(writes, 50))} / ${f(percentile(writes, 95))} / ${f(percentile(writes, 99))} | ${errors} |`;
}

try {
  const most = Math.max(50, ...STEPS);
  const everyone = await Promise.all(
    Array.from({ length: most }, (_, i) => new Person(server.base, `Person${i}`).signIn()),
  );
  // Groups of four, like flats; each person loops on their own group.
  const seats: { person: Person; groupId: string; members: string[]; me: string }[] = [];
  for (let g = 0; g < most / GROUP_SIZE; g++) {
    const people = everyone.slice(g * GROUP_SIZE, (g + 1) * GROUP_SIZE);
    const { groupId, members } = await makeGroup(people, `Flat ${g}`);
    people.forEach((person, i) => {
      seats.push({ person, groupId, members, me: members[i] ?? '' });
    });
  }

  await run(seats.slice(0, 10), 3, 0.2); // warm up: JIT, connections, caches

  const lines = [
    '| Concurrent people | Requests/s | Server CPU ms per request | Read ms p50 / p95 / p99 | Write ms p50 / p95 / p99 | Errors |',
    '|---|---|---|---|---|---|',
  ];
  for (const n of STEPS) {
    const before = await server.cpuMs();
    const samples = await run(seats.slice(0, n), SECONDS, 0.2);
    lines.push(
      row(
        n === 1 ? '1 (no contention)' : `${n}, groups of ${GROUP_SIZE}`,
        samples,
        SECONDS,
        (await server.cpuMs()) - before,
      ),
    );
    console.error(lines.at(-1));
  }

  // The worst case: one group, everyone writing at once.
  const hot = everyone.slice(0, 50);
  const { groupId, members } = await makeGroup(hot, 'Hot group');
  const hotSeats = hot.map((person, i) => ({ person, groupId, members, me: members[i] ?? '' }));
  const before = await server.cpuMs();
  const hotSamples = await run(hotSeats, SECONDS, 1);
  lines.push(row('50 in ONE group, writes only', hotSamples, SECONDS, (await server.cpuMs()) - before));

  const audit = await db.owner.query('select * from audit_ledger()');
  const total = await db.owner.query<{ n: number }>('select count(*)::int as n from transactions');

  console.log(`\nLoad test, ${SECONDS} s per step, on ${cpus().length} × ${cpus()[0]?.model.trim()}`);
  console.log('(server, Postgres and the load generator share these cores)\n');
  console.log(lines.join('\n'));
  console.log(
    `\n${total.rows[0]?.n} expenses written; ledger audit: ${audit.rows.length === 0 ? 'clean' : 'UNBALANCED'}`,
  );
} finally {
  await server.stop().catch(() => {});
  await db.drop();
}
