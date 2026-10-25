/**
 * The little of node-postgres the store needs. Neon's serverless driver has the same shape, so the store runs
 * unchanged on Node (tests, local) and on Cloudflare Workers (production).
 */
export interface Queryable {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export interface PoolClient extends Queryable {
  release(destroy?: boolean | Error): void;
}

export interface Pool {
  connect(): Promise<PoolClient>;
}

/** Postgres error codes worth retrying the whole transaction for: nothing was committed. */
const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

const MAX_ATTEMPTS = 3;

/**
 * Runs `work` in one transaction as `userId`: row-level security sees that user and nobody else, and every
 * statement commits together or not at all. Deadlocks and serialisation failures are retried, which is safe
 * because nothing from the failed attempt was kept.
 */
export async function asUser<T>(pool: Pool, userId: string, work: (sql: Queryable) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('begin');
      await client.query("select set_config('app.user_id', $1, true)", [userId]);
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      try {
        await client.query('rollback');
      } catch (rollbackError) {
        broken = rollbackError as Error; // the connection is unusable; do not return it to the pool
      }
      if (attempt < MAX_ATTEMPTS && RETRYABLE.has((error as { code?: string }).code ?? '')) continue;
      throw error;
    } finally {
      client.release(broken);
    }
  }
}
