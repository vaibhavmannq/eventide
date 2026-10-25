/**
 * Every rule the ledger enforces fails with one of these codes, so the API can turn a broken rule into a
 * 422 with a stable code instead of matching on message text.
 */
export type LedgerErrorCode =
  | 'NOT_AN_INTEGER'
  | 'UNSAFE_AMOUNT'
  | 'NON_POSITIVE_AMOUNT'
  | 'UNKNOWN_CURRENCY'
  | 'BAD_DECIMAL'
  | 'TOO_MANY_DECIMALS'
  | 'NO_PARTICIPANTS'
  | 'DUPLICATE_MEMBER'
  | 'BAD_WEIGHT'
  | 'SPLIT_MISMATCH'
  | 'PAYERS_MISMATCH'
  | 'SELF_SETTLEMENT'
  | 'UNBALANCED';

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}
