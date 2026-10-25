/**
 * A moon at any phase, lit from the right like the waxing moon in the portfolio. In Eventide it shows how settled a
 * group is: a thin crescent when a lot is owed, full when everyone is even.
 */
export function Moon({ lit, size = 40, label }: { lit: number; size?: number; label?: string }) {
  const f = Math.min(1, Math.max(0, lit));
  const r = 20;
  // The terminator is half an ellipse whose width shrinks to nothing at half moon and grows again after.
  const rx = Math.abs(1 - 2 * f) * r;
  const sweep = f > 0.5 ? 1 : 0;
  const d = `M 24 4 A ${r} ${r} 0 0 1 24 44 A ${rx} ${r} 0 0 ${sweep} 24 4 Z`;
  return (
    <svg
      class="moon"
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
    >
      <circle cx="24" cy="24" r={r} class="moon-dark" />
      {f >= 0.995 ? <circle cx="24" cy="24" r={r} class="moon-lit" /> : f > 0.005 && <path d={d} class="moon-lit" />}
    </svg>
  );
}
