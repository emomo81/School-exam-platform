import pkg from "pg";
import { env } from "./env.js";

const { Pool } = pkg;

// Single shared pool for the API process. Supabase requires SSL.
export const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

/** Run `fn` inside a transaction, committing on success and rolling back on throw. */
export async function withTransaction<T>(
  fn: (client: pkg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
