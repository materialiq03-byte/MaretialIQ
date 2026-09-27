/**
 * Database adapter core (Step 6B).
 *
 * The application's data layer speaks one narrow interface:
 *   prepare(sql).run/get/all + exec + { lastInsertRowid, changes } results +
 *   the withTransaction helper — all reached through db/client. This module
 *   holds the CONTRACT and the per-dialect executors; db/client composes them
 *   into the single seam (getDb/getDataApi/withTransaction) so none of the 25
 *   data-layer files change.
 *
 * Behavior contract:
 *  - SQLite (default): SQL passes through BYTE-IDENTICAL (no translation) and
 *    results wrap the native node:sqlite results 1:1. All existing tests and
 *    production behavior are untouched.
 *  - PostgreSQL (MATERIALIQ_DB_DIALECT=postgresql): every statement is run
 *    through translateStatement() (db/dialect.ts) — INSERT OR IGNORE becomes
 *    ON CONFLICT DO NOTHING with an explicit target, COLLATE NOCASE becomes
 *    ILIKE, json_extract becomes JSONB #>> path, BEGIN IMMEDIATE becomes
 *    BEGIN. Executing PG SQL needs a live driver executor supplied via
 *    setAdapterForTests — none is wired in Step 6B (Supabase stays untouched;
 *    the cutover is a later step).
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { translateStatement } from './dialect';

/**
 * The narrow data API every repository/service already uses.
 * Structural subset of node:sqlite's DatabaseSync — DatabaseSync satisfies it
 * directly, which keeps the SQLite path allocation-free.
 */
export interface DataApi {
  prepare(sql: string): PreparedStatementApi;
  exec(sql: string): void;
}

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface PreparedStatementApi {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** Per-dialect statement executor the adapter delegates to. */
export interface StatementExecutor {
  dialect: 'sqlite' | 'postgresql';
  prepare(sql: string): PreparedStatementApi;
  exec(sql: string): void;
  /**
   * Optional transaction-session API (PostgresExecutor): when present,
   * withTransaction routes the whole fn through ONE pooled client. Executors
   * without it (injected test fakes) fall back to exec('BEGIN'/'COMMIT').
   */
  beginTransaction?(): number;
  commitTransaction?(session: number): void;
  rollbackTransaction?(session: number): void;
}

// ---------------------------------------------------------------------------
// SQLite executor — the production path. Identity translation, native results.
// Built against a lazily-supplied connection so db/client stays the single
// owner of the node:sqlite connection (no import cycle).
// ---------------------------------------------------------------------------

class SqlitePreparedStatement implements PreparedStatementApi {
  constructor(private readonly stmt: StatementSync) {}
  run(...params: unknown[]): RunResult {
    return this.stmt.run(...(params as never[])) as RunResult;
  }
  get(...params: unknown[]): unknown {
    return this.stmt.get(...(params as never[]));
  }
  all(...params: unknown[]): unknown[] {
    return this.stmt.all(...(params as never[])) as unknown[];
  }
}

export function makeSqliteExecutor(getConn: () => DatabaseSync): StatementExecutor {
  return {
    dialect: 'sqlite',
    prepare(sql: string): PreparedStatementApi {
      return new SqlitePreparedStatement(getConn().prepare(sql));
    },
    exec(sql: string): void {
      getConn().exec(sql);
    },
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL executor shim. SQL is translated through the dialect layer; the
// wire protocol arrives with the later cutover via setAdapterForTests.
// ---------------------------------------------------------------------------

function pgNotWired(op: string): Error {
  return new Error(
    `PostgreSQL executor cannot ${op} in Step 6B (cutover is a later step). Provide a live executor via setAdapterForTests in integration tests.`
  );
}

/**
 * Deterministic PG statement shim: exposes the TRANSLATED SQL so tests can
 * pin exactly what the dialect layer produces for repository SQL. Execution
 * itself is intentionally unavailable until a driver is wired.
 */
export class PgPreparedStatement implements PreparedStatementApi {
  constructor(public readonly translatedSql: string) {}
  run(..._params: unknown[]): RunResult {
    throw pgNotWired('run');
  }
  get(..._params: unknown[]): unknown {
    throw pgNotWired('get');
  }
  all(..._params: unknown[]): unknown[] {
    throw pgNotWired('all');
  }
}

export const pgExecutor: StatementExecutor = {
  dialect: 'postgresql',
  prepare(sql: string): PreparedStatementApi {
    return new PgPreparedStatement(translateStatement(sql, 'postgresql'));
  },
  exec(_sql: string): void {
    throw pgNotWired('exec');
  },
};

// ---------------------------------------------------------------------------
// Active-executor registry. Default = SQLite; tests/integration may inject.
// ---------------------------------------------------------------------------

let activeExecutor: StatementExecutor | null = null;

/** Test/integration hook: swap the active statement executor (null resets). */
export function setAdapterForTests(executor: StatementExecutor | null): void {
  activeExecutor = executor;
}

export function getActiveExecutor(fallbackFactory: () => StatementExecutor): StatementExecutor {
  return activeExecutor ?? fallbackFactory();
}

/**
 * Wrap any executor into the DataApi shape (contract conformance for
 * injected executors and tests).
 */
export function makeAdapterDataApi(executor: StatementExecutor): DataApi {
  return {
    prepare(sql: string): PreparedStatementApi {
      return executor.prepare(sql);
    },
    exec(sql: string): void {
      executor.exec(sql);
    },
  };
}
