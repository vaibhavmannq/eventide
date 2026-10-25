/**
 * Tonight's moon, for the log line, like the portfolio's voyage log ("Waxing crescent · 6% lit"). Counted in
 * synodic months from a known new moon; accurate to within a day or so, which is all a phase name needs.
 */
const SYNODIC_DAYS = 29.530588853;
const KNOWN_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14); // 2000-01-06 18:14 UTC

export function moonTonight(at = new Date()): { name: string; lit: number; age: number } {
  const days = (at.getTime() - KNOWN_NEW_MOON) / 86_400_000;
  const age = ((days % SYNODIC_DAYS) + SYNODIC_DAYS) % SYNODIC_DAYS;
  const lit = (1 - Math.cos((2 * Math.PI * age) / SYNODIC_DAYS)) / 2;
  const names: [number, string][] = [
    [1.84566, 'New moon'],
    [5.53699, 'Waxing crescent'],
    [9.22831, 'First quarter'],
    [12.91963, 'Waxing gibbous'],
    [16.61096, 'Full moon'],
    [20.30228, 'Waning gibbous'],
    [23.99361, 'Last quarter'],
    [27.68493, 'Waning crescent'],
    [SYNODIC_DAYS, 'New moon'],
  ];
  const name = names.find(([until]) => age < until)?.[1] ?? 'New moon';
  return { name, lit, age };
}
