/** The API's error shape (packages/api/src/errors.ts): every failure has a stable code and a readable message. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** True when the request never reached the server: offline, or the connection dropped. Worth retrying later. */
export const isNetworkError = (error: unknown) => error instanceof TypeError;

export async function api<T>(
  method: string,
  path: string,
  options: { body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  const response = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: options.body === undefined ? null : JSON.stringify(options.body),
  });
  if (response.status === 204) return undefined as T;
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const error = json?.error ?? {};
    throw new ApiError(response.status, error.code ?? 'HTTP', error.message ?? response.statusText, error.details);
  }
  return json as T;
}
