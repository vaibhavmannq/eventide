import { StoreError } from '@eventide/db';
import { LedgerError } from '@eventide/ledger';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';

/** An error the client caused, with the status and stable code to send back. */
export class HttpError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly details: unknown;

  constructor(status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const STORE_STATUS: Record<StoreError['code'], ContentfulStatusCode> = {
  NOT_FOUND: 404,
  CONFLICT: 409,
  ALREADY_EXISTS: 409,
  IDEMPOTENCY_MISMATCH: 422,
  UNKNOWN_MEMBER: 422,
  KIND_MISMATCH: 422,
  FORBIDDEN: 403,
  NOT_SETTLED: 409,
};

/**
 * Turns any error into what the client sees. Every response body has the same shape,
 * `{ error: { code, message, details? } }`, so the app handles errors in one place.
 * Anything unexpected becomes a 500 with no internals in the message; the log has the detail.
 */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return new HttpError(400, 'INVALID_REQUEST', 'The request is not valid', details);
  }
  if (error instanceof LedgerError) return new HttpError(422, error.code, error.message);
  if (error instanceof StoreError) {
    return new HttpError(STORE_STATUS[error.code], error.code, error.message, error.current ?? undefined);
  }
  return new HttpError(500, 'INTERNAL', 'Something went wrong on our side');
}
