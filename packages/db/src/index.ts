import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export * from "./schema.js";
export { schema };
export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
  const db = drizzle(pool, { schema });
  return { pool, db, close: () => pool.end() };
}
export type Database = ReturnType<typeof createDatabase>;
