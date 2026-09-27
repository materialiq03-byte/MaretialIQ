/**
 * SQLite client / database seam (Node built-in node:sqlite). One connection
 * per process, WAL mode, foreign keys ON, busy timeout for dev-server
 * concurrency.
 *
 * Step 6B: this module is the SINGLE adapter seam. Repositories, services and
 * auth code keep calling getDb()/withTransaction() exactly as before:
 *   - SQLite (default): getDb() returns the raw DatabaseSync — byte-identical
 *     behavior; PRAGMAs stay isolated here.
 *   - PostgreSQL dialect (MATERIALIQ_DB_DIALECT=postgresql): getDb() returns
 *     an adapter-backed DataApi (db/adapter.ts) whose statements carry
 *     dialect-translated SQL (db/dialect.ts). The live PG connection is wired
 *     in a later step; the contract is pinned by tests/adapter.test.ts.
 *
 * Statement-compat note: node:sqlite's DatabaseSync#prepare returns
 * StatementSync with run/get/all, structurally satisfying the adapter's
 * PreparedStatementApi. The PG adapter exposes the same three methods, so
 * every `.prepare(...).run/get/all` call site works against both dialects
 * unchanged.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import {
  getActiveExecutor,
  makeAdapterDataApi,
  makeSqliteExecutor,
  setAdapterForTests as setExecutorForTests,
  type DataApi,
  type StatementExecutor,
} from './adapter';
import { getDialect } from './dialect';
import { PostgresExecutor } from './pg-executor';

let db: DatabaseSync | null = null;

/** Open the process-wide SQLite connection (SQLite-specific: PRAGMAs live here). */
function openSqlite(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = config.dbPath || path.join(config.dataDir, 'materialiq.db');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

// Default executor: wraps the process-wide SQLite connection.
const sqliteExecutor: StatementExecutor = makeSqliteExecutor(() => openSqlite());

/**
 * Primary data entrypoint for ALL repositories/services/auth code.
 *
 * SQLite (default): returns the raw DatabaseSync — the exact pre-6B object.
 * PostgreSQL dialect: returns a DataApi whose prepare() runs
 * translateStatement() and whose execution must be provided by an injected
 * live executor (setAdapterForTests / the later cutover).
 */
export function getDb(): DataApi {
  if (getDialect() === 'postgresql') {
    // An INJECTED executor (setAdapterForTests) always wins over the live one
    // — that is the integration-test seam. Without injection, the live
    // PostgresExecutor is constructed lazily (clear config error if
    // MATERIALIQ_DATABASE_URL is missing).
    return makeAdapterDataApi(getActiveExecutor(() => getPgExecutor()));
  }
  return openSqlite();
}

/**
 * Live PostgreSQL executor for the active process. Lazily constructed on the
 * first PG-dialect getDb()/withTransaction call; requires
 * MATERIALIQ_DATABASE_URL (config error otherwise, per Step 6C §D).
 */
let pgExecutorSingleton: PostgresExecutor | null = null;
export function getPgExecutor(): PostgresExecutor {
  if (!pgExecutorSingleton) {
    pgExecutorSingleton = new PostgresExecutor();
  }
  return pgExecutorSingleton;
}

/** Close the live PG pool (tests / graceful shutdown). No-op on SQLite. */
export function closePostgresExecutor(): void {
  if (pgExecutorSingleton) {
    pgExecutorSingleton.close();
    pgExecutorSingleton = null;
  }
}

/**
 * Raw SQLite connection for infrastructure that is SQLite-only by definition:
 * the migration runner, PRAGMA queries, file location. Never translated.
 */
export function getRawSqliteDb(): DatabaseSync {
  return openSqlite();
}

/**
 * File path of the ACTIVE SQLite connection (via PRAGMA database_list) —
 * works for injected test connections too. Null when unknown (never opened,
 * or :memory:). SQLite-only by definition (PostgreSQL has no database file).
 */
export function getDbFile(): string | null {
  if (!db) return null;
  try {
    const rows = db.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>;
    const main = rows.find((r) => r.name === 'main');
    return main?.file || null;
  } catch {
    return null;
  }
}

/** Test helper: swap the underlying SQLite connection (existing seam). */
export function setDbForTests(instance: DatabaseSync): void {
  db = instance;
}

/**
 * Test/integration hook: swap the active statement executor (null resets to
 * the default SQLite executor). Used by tests/adapter.test.ts and, later, by
 * the env-gated PostgreSQL integration suite.
 */
export function setAdapterForTests(executor: StatementExecutor | null): void {
  setExecutorForTests(executor);
}

/** Run a function inside a transaction; rolls back on throw. */
export function withTransaction<T>(fn: () => T): T {
  if (getDialect() === 'postgresql') {
    // PG path: all statements inside fn must run on ONE pool client. Live
    // executors hold a transaction session (prepare()d statements route into
    // it until commit/rollback); injected fakes without session support fall
    // back to exec('BEGIN'/'COMMIT'). Nested PG transactions are not part of
    // the prototype contract.
    const executor = getActiveExecutor(() => getPgExecutor());
    if (typeof executor.beginTransaction === 'function' && typeof executor.commitTransaction === 'function') {
      const session = executor.beginTransaction();
      try {
        const result = fn();
        executor.commitTransaction(session);
        return result;
      } catch (err) {
        try {
          executor.rollbackTransaction?.(session);
        } catch {
          /* connection already gone */
        }
        throw err;
      }
    }
    const conn = makeAdapterDataApi(executor);
    conn.exec('BEGIN');
    try {
      const result = fn();
      conn.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        conn.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  }
  const conn = openSqlite();
  conn.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      conn.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}
