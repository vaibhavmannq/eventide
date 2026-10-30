import { z } from 'zod';

/**
 * The shape of every request body. Checked before anything reaches the ledger or the database; the ledger
 * then checks the rules about money (does it add up), and the database checks them again.
 * Amounts are whole numbers of minor units, as everywhere else (ADR 0002).
 */

const id = z.uuid();
const currency = z.string().regex(/^[A-Z]{3}$/, 'A three-letter currency code, like GBP');
// A trillion minor units (10 billion rupees, pounds or dollars) is far beyond any shared bill, and keeps every sum
// of up to 100 people's amounts exact in JavaScript and in Postgres's bigint.
export const MAX_AMOUNT = 1_000_000_000_000;
const amount = z.int().min(-MAX_AMOUNT).max(MAX_AMOUNT);
const name = z.string().trim().min(1).max(100);
const people = <T extends z.ZodType>(item: T) => z.array(item).min(1).max(100);

const share = z.strictObject({ member: id, amount });

const split = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('equal'), members: people(id) }),
  z.strictObject({ kind: z.literal('exact'), amounts: people(share) }),
  z.strictObject({
    kind: z.literal('percent'),
    parts: people(z.strictObject({ member: id, basisPoints: z.int().min(0).max(10000) })),
  }),
  z.strictObject({
    kind: z.literal('shares'),
    parts: people(z.strictObject({ member: id, weight: z.int().min(0).max(1_000_000) })),
  }),
]);

export const transaction = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('expense'),
    currency,
    total: amount.positive(),
    paidBy: people(share),
    split,
  }),
  z.strictObject({ kind: z.literal('settlement'), currency, from: id, to: id, amount: amount.positive() }),
]);

const details = {
  description: z.string().trim().max(200).default(''),
  occurredOn: z.iso.date(),
  transaction,
};

export const recordBody = z.strictObject({ id, ...details });
export const editBody = z.strictObject({ expectedRevision: z.int().min(1), ...details });

export const newGroup = z.strictObject({ name, currency, displayName: name });
export const newMember = z.strictObject({ displayName: name });
export const acceptBody = z.union([z.strictObject({ displayName: name }), z.strictObject({ claim: id })]);
export const devLogin = z.strictObject({ email: z.email().max(200), name, next: z.string().max(500).optional() });

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const handoffExchange = z.strictObject({ code: token, verifier: token });

export const idempotencyKey = id;
export const groupId = id;
export const revision = z.coerce.number().pipe(z.int().min(1));
export const afterSeq = z.coerce.number().pipe(z.int().min(0)).default(0);
