/**
 * DuckDB test helper — creates an in-memory database with all tables.
 */
import duckdb from "duckdb";
import { initDatabase } from "../../db/init.js";

export interface TestDb {
  db: InstanceType<typeof duckdb.Database>;
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
  close(): void;
}

export async function createTestDb(): Promise<TestDb> {
  const db = new duckdb.Database(":memory:");
  const conn = db.connect();

  function query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
      conn.all(sql, ...params, (err: Error | null, rows: Record<string, unknown>[]) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  function run(sql: string, params: unknown[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      conn.run(sql, ...params, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // Initialize all tables
  await initDatabase(db);

  return {
    db,
    query,
    run,
    close() {
      db.close();
    },
  };
}
