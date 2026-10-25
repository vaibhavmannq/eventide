# 0002 — Money is a whole number of minor units

Date: 2026-10-25 · Status: accepted

## Context

In floating point `0.1 + 0.2 === 0.30000000000000004` and `0.29 * 100 === 28.999999999999996`. A split that drifts
by a fraction of a penny stops adding up, and once that happens the invariant (DESIGN §5.3) cannot be checked.

## Options

- **Floats.** Wrong.
- **A decimal library** (big.js, decimal.js). Exact, but every value needs wrapping, JSON needs custom encoding, and
  it adds a dependency to the hottest code.
- **Whole numbers of the smallest unit** (pence, cents, yen), with the number of decimals per currency from
  ISO 4217.

## Decision

Whole numbers of minor units, as JavaScript numbers checked with `Number.isSafeInteger`, and `bigint` in Postgres.
Amounts are parsed from text digit by digit and never pass through a float. Where an intermediate product could
pass 2^53 (allocation), the arithmetic runs in BigInt.

## Consequences

- Each amount must carry its currency, because 1230 means £12.30 but ¥1230.
- The largest single amount is about 90 trillion pounds. That is enough.
