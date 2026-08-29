// Stand-in for expo-sqlite built on bun:sqlite so the harness exercises the
// app's REAL SQL against a REAL SQLite engine. This is what would have caught
// the missing-column migration bug instantly.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const DB_DIR = process.env.NC_HARNESS_DB_DIR ?? join(import.meta.dir, ".data");
mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = join(DB_DIR, "naturallycurious.db");

let db: Database | null = null;

function conn(): Database {
  if (!db) db = new Database(DB_PATH);
  return db;
}

function normalize(params?: unknown[]): unknown[] {
  return Array.isArray(params) ? params : params ? [params] : [];
}

export async function openDatabaseAsync(_name: string) {
  const c = conn();
  return {
    async execAsync(sql: string) {
      c.exec(sql);
    },
    async runAsync(sql: string, ...args: unknown[]) {
      const params = args.flat();
      const res = c.run(sql, ...normalize(params as unknown[]));
      return { changes: res.changes, lastInsertRowId: Number(res.lastInsertRowid) };
    },
    async getAllAsync<T>(sql: string, ...args: unknown[]) {
      return c.query(sql).all(...normalize(args.flat())) as T[];
    },
    async getFirstAsync<T>(sql: string, ...args: unknown[]) {
      return (c.query(sql).get(...normalize(args.flat())) ?? null) as T | null;
    },
    async withTransactionAsync(fn: () => Promise<void>) {
      c.exec("BEGIN");
      try {
        await fn();
        c.exec("COMMIT");
      } catch (err) {
        c.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

export const harnessDbPath = DB_PATH;
