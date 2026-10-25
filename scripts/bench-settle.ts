/**
 * Times settleUp at the sizes around EXACT_LIMIT, so the limit is set by a measurement (docs/DESIGN.md §5.5).
 * Run: node --experimental-strip-types scripts/bench-settle.ts
 */
import { settleUp } from '../packages/ledger/src/index.ts';

function balances(n: number, seed: number): Map<string, number> {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state;
  };
  const amounts = Array.from({ length: n - 1 }, () => (next() % 20001) - 10000 || 1);
  const last = -amounts.reduce((a, b) => a + b, 0);
  return new Map([...amounts, last || 1].map((amount, index) => [`m${index}`, amount]));
}

for (const n of [10, 12, 14, 15, 16, 18]) {
  const runs = 30;
  const times: number[] = [];
  for (let run = 0; run < runs + 5; run++) {
    const input = balances(n, run + 1);
    if ([...input.values()].reduce((a, b) => a + b, 0) !== 0) continue;
    const start = performance.now();
    settleUp(input, 64);
    if (run >= 5) times.push(performance.now() - start); // the first runs warm up the JIT
  }
  times.sort((a, b) => a - b);
  const pct = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))]?.toFixed(2);
  console.log(`n=${n}  median ${pct(0.5)} ms  p95 ${pct(0.95)} ms  max ${pct(1)} ms`);
}
