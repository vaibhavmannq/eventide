export type StoreErrorCode =
  /** The group or transaction does not exist, or the user cannot see it. The two are deliberately the same. */
  | 'NOT_FOUND'
  /** Someone else changed the transaction since the client read it. `current` holds what it is now. */
  | 'CONFLICT'
  /** The id is already used by a different transaction. */
  | 'ALREADY_EXISTS'
  /** The idempotency key was already used for a different request. */
  | 'IDEMPOTENCY_MISMATCH'
  /** The transaction names someone who is not an active member of the group. */
  | 'UNKNOWN_MEMBER'
  /** An edit tried to turn an expense into a payment or the other way round. */
  | 'KIND_MISMATCH'
  /** Only the person who started the group can do this. */
  | 'FORBIDDEN'
  /** Someone still owes or is owed money in this group, so they cannot leave or be removed yet. */
  | 'NOT_SETTLED'
  /** One of the limits per person in limits.ts. */
  | 'LIMIT_REACHED';

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly current: unknown;

  constructor(code: StoreErrorCode, message: string, current?: unknown) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.current = current;
  }
}
