/**
 * PostgreSQL executor (Step 6C): the live StatementExecutor behind the
 * adapter contract, speaking to Supabase/PostgreSQL through node-postgres.
 *
 * THE SYNC PROBLEM, AND WHY A WORKER THREAD:
 * node:sqlite is synchronous — every repository does
 * `getDb().prepare(sql).run(...)` and consumes the result immediately. `pg`
 * is asynchronous only; rewriting 25 data-layer files to await would be a
 * business-logic rewrite (forbidden). The standard bridge is therefore used:
 *
 *   - A dedicated worker thread (worker_threads.Worker) owns the pg Pool and
 *     performs every async round-trip on its own event loop.
 *   - Request/response payloads travel through a SharedArrayBuffer; the
 *     worker writes the JSON response, then Atomics.notify wakes the main
 *     thread which is parked inside Atomics.wait. (This only works with
 *     worker_threads — a child process shares no memory, so its messages can
 *     never wake a blocked thread.)
 *   - The DataApi contract stays synchronous; repository code is untouched.
 *   - Calls are inherently serialized (one in-flight call at a time), which
 *     also makes transaction sessions trivial to route.
 *
 * Transactions: the worker acquires ONE pool client per transaction session
 * and runs BEGIN / each statement / COMMIT-ROLLBACK on that client, so real
 * per-statement rowCount/rows are visible inside withTransaction (business
 * code reads `changes` mid-transaction — deferred execution would lie).
 *
 * Connection strategy (§M): a single pg.Pool per process inside the worker
 * (max 5, idle 30s, connect timeout 10s). Clients are always released back;
 * none is held outside an active transaction session.
 *
 * Security (§L): the connection string lives only in workerData/env of the
 * worker — never on the main thread, never logged, never client-side.
 *
 * Known limits (documented, prototype-honest): one in-flight query; result
 * payloads must fit the shared buffer (4 MB); the bridge parks one OS thread
 * per call — acceptable for the verification suite, superseded by the async
 * cutover.
 */

import { translateStatement } from './dialect';
import type { PreparedStatementApi, RunResult, StatementExecutor } from './adapter';

const WORKER_SOURCE = /* js */ `
const { Pool } = require(workerData.pgModulePath || 'pg');
const { workerData, parentPort } = require('node:worker_threads');

const sab = workerData.sab;
const view = new Int32Array(sab, 0, 2);      // [flag, length]
const payloadBytes = new Uint8Array(sab, 8); // JSON response body

let pool = null;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: workerData.connectionString,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      // Step 10: SSL policy is resolved on the main thread (CA-pinned
      // verify-full by default) and passed in via workerData. A literal
      // false (sslmode=disable) passes through untouched.
      ssl: workerData.sslConfig ?? { rejectUnauthorized: false },
    });
    pool.on('error', () => {});
  }
  return pool;
}

const sessions = new Map(); // sessionId -> pg client (checked out)
let nextSession = 1;

// PostgreSQL type OIDs for contract coercion (type-driven, not shape-guessing:
// a TEXT column holding '6205' must stay a string).
const OID_BOOL = 16, OID_JSON = 114, OID_JSONB = 3802, OID_INT8 = 20, OID_NUMERIC = 1700;

/**
 * Rebuild a result row with contract-tagged values:
 *  - bool        -> { __pgBool } (main thread revives to SQLite 0/1)
 *  - json/jsonb  -> { __pgJson: text } (SQLite stores JSON docs as TEXT)
 *  - int8/numeric-> { __pgNum: string } (pg returns strings; SQLite numbers)
 *  - timestamptz -> ISO-8601 TEXT (node:sqlite parity), tagged by tagDates()
 */
function coerceRow(row, fields) {
  const out = {};
  for (const f of fields) {
    const oid = f.dataTypeID; // node-postgres FieldDef carries the type OID here
    const v = row[f.name];
    if (v instanceof Date) { out[f.name] = { __pgDate: v.toISOString() }; continue; }
    if (v === null || v === undefined) { out[f.name] = v; continue; }
    if (oid === OID_BOOL) { out[f.name] = { __pgBool: v === true }; continue; }
    if ((oid === OID_JSON || oid === OID_JSONB) && typeof v === 'object') {
      out[f.name] = { __pgJson: JSON.stringify(v) };
      continue;
    }
    if ((oid === OID_INT8 || oid === OID_NUMERIC) && typeof v === 'string') {
      out[f.name] = { __pgNum: v };
      continue;
    }
    out[f.name] = v;
  }
  return out;
}

async function runJob(job) {
  switch (job.op) {
    case 'query': {
      const res = await getPool().query(job.sql, job.params);
      return { rowCount: res.rowCount, rows: (res.rows ?? []).map((r) => coerceRow(r, res.fields ?? [])) };
    }
    case 'txn-begin': {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        const id = nextSession++;
        sessions.set(id, client);
        return { sessionId: id };
      } catch (err) {
        client.release();
        throw err;
      }
    }
    case 'txn-query': {
      const client = sessions.get(job.session);
      if (!client) throw new Error('Unknown transaction session');
      const res = await client.query(job.sql, job.params);
      return { rowCount: res.rowCount, rows: (res.rows ?? []).map((r) => coerceRow(r, res.fields ?? [])) };
    }
    case 'txn-commit': {
      const client = sessions.get(job.session);
      if (!client) throw new Error('Unknown transaction session');
      sessions.delete(job.session);
      try { await client.query('COMMIT'); } finally { client.release(); }
      return {};
    }
    case 'txn-rollback': {
      const client = sessions.get(job.session);
      if (!client) { return {}; }
      sessions.delete(job.session);
      try { await client.query('ROLLBACK'); } finally { client.release(); }
      return {};
    }
    case 'end': {
      if (pool) await pool.end();
      return {};
    }
    default:
      throw new Error('Unknown op ' + job.op);
  }
}

function tagDates(v) {
  if (v instanceof Date) return { __pgDate: v.toISOString() };
  if (Array.isArray(v)) return v.map(tagDates);
  if (v !== null && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = tagDates(v[k]);
    return o;
  }
  return v;
}

parentPort.on('message', (raw) => {
  // The main thread posts a JSON string envelope (a plain object post would
  // also work, but strings keep the protocol explicit across the bridge).
  const job = typeof raw === 'string' ? JSON.parse(raw) : raw;
  runJob(job)
    .then((result) => {
      // pg parses timestamptz into JS Date; JSON.stringify would flatten it to
      // a string and break the DataApi contract (node:sqlite returns Date).
      // Date.toJSON() outruns a stringify replacer, so walk the tree first.
      const json = Buffer.from(JSON.stringify({ ok: true, ...tagDates(result) }), 'utf8');
      if (json.length > payloadBytes.length) {
        const err = Buffer.from(JSON.stringify({ ok: false, error: 'Result payload exceeds shared buffer' }));
        payloadBytes.set(err, 0); view[1] = err.length; view[0] = 1;
      } else {
        payloadBytes.set(json, 0); view[1] = json.length; view[0] = 1;
      }
      Atomics.notify(view, 0);
    })
    .catch((err) => {
      const json = Buffer.from(JSON.stringify({ ok: false, error: String((err && err.message) || err) }), 'utf8');
      payloadBytes.set(json, 0); view[1] = json.length; view[0] = 1;
      Atomics.notify(view, 0);
    });
});
`;

const SAB_BYTES = 4 * 1024 * 1024; // 4 MB result ceiling (documented limitation)
const CALL_TIMEOUT_MS = 120_000;

/**
 * Step 10 — SSL hardening: CA-pinned TLS is the DEFAULT.
 *
 * Supabase retired its public CA download URL (the certificate is now
 * distributed via the dashboard only), so the CA is bootstrapped ONCE from
 * the server's live TLS chain — extracted over an already-encrypted channel
 * — and then PINNED: every connection afterwards validates the full chain
 * against certs/supabase-ca.crt with rejectUnauthorized:true. That is the
 * node-postgres equivalent of libpq sslmode=verify-full (CA + hostname).
 *
 * Serverless runtimes (Vercel Preview) cannot ship the gitignored local CA
 * file, so the pinned CA may alternatively arrive through the
 * MATERIALIQ_PG_SSL_CA secret (raw PEM, injected as an environment variable
 * and never committed). Both sources produce the identical verify-full
 * policy; the chain is still fully validated either way.
 *
 * MATERIALIQ_PG_SSL=insecure explicitly restores the legacy accept-any mode
 * (offline experiments only — never the default).
 */
/**
 * TLS trust material for CA-pinned mode, in priority order:
 *   1. MATERIALIQ_PG_SSL_CA secret (raw PEM) — for serverless runtimes where
 *      the gitignored cert file cannot be packaged.
 *   2. certs/supabase-ca.crt on disk — the local/bootstrap-pinned path.
 * The caller fails closed when neither is present.
 */
function caTrustPem(): { source: string; pem: string } | undefined {
  const fromEnv = (process.env.MATERIALIQ_PG_SSL_CA || '').trim();
  if (fromEnv) return { source: 'MATERIALIQ_PG_SSL_CA', pem: fromEnv };
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const caPath = path.join(process.cwd(), 'certs', 'supabase-ca.crt');
  if (fs.existsSync(caPath)) {
    return { source: 'certs/supabase-ca.crt', pem: fs.readFileSync(caPath, 'utf8') };
  }
  return undefined;
}

export function resolveSslConfig(): Record<string, unknown> | undefined {
  const mode = (process.env.MATERIALIQ_PG_SSL || '').trim().toLowerCase();
  if (mode === 'disable') {
    // libpq sslmode=disable equivalent: plaintext. Only meaningful for
    // isolated local test containers (the official postgres image ships with
    // SSL off); production Supabase terminates non-SSL connections.
    return false as unknown as Record<string, unknown>;
  }
  if (mode === 'insecure') {
    return { rejectUnauthorized: false };
  }
  const trust = caTrustPem();
  if (trust) {
    return {
      ca: trust.pem,
      rejectUnauthorized: true,
      // Explicit SNI/hostname target: the node checkServerIdentity equivalent
      // of libpq verify-full's hostname check.
      servername: hostOf(process.env.MATERIALIQ_DATABASE_URL || ''),
    };
  }
  // Fail closed: no pinned CA (env or file) and no insecure override. The
  // one-time CA bootstrap is a separate script (TLS extraction is async; the
  // executor's constructor is deliberately synchronous).
  throw new Error(
    'PostgreSQL SSL hardening: no CA trust material (certs/supabase-ca.crt not found and MATERIALIQ_PG_SSL_CA not set). ' +
      'In serverless deployments set the MATERIALIQ_PG_SSL_CA secret to the Supabase CA PEM, ' +
      'or run `npx tsx scripts/bootstrap-pg-ca.ts` once locally, ' +
      'or set MATERIALIQ_PG_SSL=insecure to opt out (not recommended).'
  );
}

function hostOf(connectionString: string): string {
  try {
    return new URL(connectionString).hostname;
  } catch {
    return '';
  }
}

/**
 * Absolute path of the `pg` package entry, resolved on the main thread (whose
 * module resolution is guaranteed to see the project's node_modules). The
 * worker requires pg through this path when its own source file lives outside
 * the project tree and bare `require('pg')` would fail.
 */
function pgModulePath(): string | undefined {
  try {
    return require.resolve('pg');
  } catch {
    return undefined;
  }
}

/**
 * Rewrite SQLite-style `?` placeholders to PostgreSQL `$1, $2, ...` numbering.
 * Quote-aware: `?` inside '...' or "..." literals is left alone (e.g. 'a?b').
 * PostgreSQL has no anonymous `?`, so repositories keep writing SQLite style
 * while the executor produces valid PG parameter syntax.
 */
export function convertPlaceholders(sql: string): string {
  let out = '';
  let n = 0;
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      out += c;
      if (c === quote) {
        if (sql[i + 1] === quote) { out += sql[i + 1]; i++; } // escaped ''
        else quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; out += c; continue; }
    if (c === '?') { n += 1; out += '$' + n; continue; }
    out += c;
  }
  return out;
}

/**
 * Tables whose PostgreSQL primary key is a generated integer `id` column
 * (bigint GENERATED BY DEFAULT AS IDENTITY in the reviewed v11 schema).
 *
 * The repository layer follows the SQLite DataApi contract: after
 * `prepare(INSERT...).run(...)` it reads `RunResult.lastInsertRowid` to fetch
 * the generated key (e.g. import-repository.createImport ->
 * getImportRequired(Number(res.lastInsertRowid))). To emulate that contract,
 * INSERTs into THESE tables get `RETURNING id` appended and run() exposes the
 * returned key as lastInsertRowid.
 *
 * Deliberately NOT in this set:
 *  - sessions / matching_runs / import_runs  (text primary keys)
 *  - matching_run_chunks / import_run_chunks / import_rows / _migrations
 *    (composite or natural keys, no `id` column — appending RETURNING id
 *    would be a PostgreSQL error, so the allowlist is mandatory, not optional)
 *
 * ON CONFLICT note: appending RETURNING id is valid on conflict-clause
 * INSERTs; PostgreSQL returns rowCount 0 and no rows when the conflict path
 * is DO NOTHING, which run() maps to lastInsertRowid 0 — matching SQLite's
 * changes:0 semantics (app code must not read a rowid after a no-op insert;
 * the Step-9.5 guarded upsert already ensures that).
 */
const IDENTITY_TABLES: ReadonlySet<string> = new Set([
  'organizations',
  'data_imports',
  'material_records',
  'material_attributes',
  'match_candidates',
  'match_decisions',
  'review_queue',
  'common_materials',
  'material_mappings',
  'audit_logs',
  'evaluation_runs',
  'users',
  'suppliers',
  'procurement_records',
]);

/**
 * If `rawSql` is an INSERT into an identity table, return the `RETURNING id`
 * suffix to append; otherwise null (statement must be left untouched).
 * Handles INSERT [OR IGNORE] INTO "table" with leading whitespace and a
 * trailing semicolon (stripped by the caller before suffixing).
 */
function returningIdSuffix(rawSql: string): string | null {
  const m = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+"?(\w+)"?/i.exec(rawSql);
  if (!m) return null;
  return IDENTITY_TABLES.has(m[1].toLowerCase()) ? '\nRETURNING id' : null;
}

export class PostgresExecutor implements StatementExecutor {
  readonly dialect = 'postgresql' as const;

  private worker: import('node:worker_threads').Worker | null = null;
  private sab: SharedArrayBuffer | null = null;
  private view: Int32Array | null = null;
  private payload: Uint8Array | null = null;
  private nextId = 1;
  private readonly connectionString: string;
  private readonly sslConfig: Record<string, unknown> | undefined;
  private closed = false;
  private workerSourcePath: string | null = null;

  /** Active transaction session id; prepare() routes through it. */
  private activeSession: number | null = null;

  constructor(connectionString?: string) {
    const cs = connectionString ?? process.env.MATERIALIQ_DATABASE_URL;
    if (!cs) {
      throw new Error(
        'PostgreSQL dialect requested but MATERIALIQ_DATABASE_URL is not set. ' +
          'Provide the Supabase connection string (server-side only, e.g. in .env.local) ' +
          'or keep MATERIALIQ_DB_DIALECT=sqlite.'
      );
    }
    this.connectionString = cs;
    this.sslConfig = resolveSslConfig();
  }

  /** Lazily spawn the worker (constructing the executor never connects). */
  private ensureWorker(): void {
    if (this.closed) throw new Error('PostgreSQL executor has been closed');
    if (this.worker) return;
    const { Worker } = require('node:worker_threads') as typeof import('node:worker_threads');
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    this.sab = new SharedArrayBuffer(SAB_BYTES);
    this.view = new Int32Array(this.sab, 0, 2);
    this.payload = new Uint8Array(this.sab, 8);
    // The worker source MUST live inside the project tree so its
    // require('pg') resolves against the project's node_modules (a tmpdir
    // file cannot see node_modules). node_modules/.cache is git-ignored.
    // Serverless runtimes mount the bundle read-only, so the cache dir must
    // be writable: probe-write each candidate (explicit override, legacy
    // node_modules/.cache, the OS temp dir) and use the first that accepts a
    // real write. NODE_PATH is exported to the worker so require('pg') still
    // resolves to the project's node_modules when the source lands outside
    // the project tree.
    const os = require('node:os') as typeof import('node:os');
    const candidates = [
      process.env.MATERIALIQ_CACHE_DIR,
      path.join(process.cwd(), 'node_modules', '.cache'),
      os.tmpdir(),
    ].filter((d): d is string => !!d);
    let cacheDir = candidates[candidates.length - 1];
    const probe = `materialiq-probe-${process.pid}`;
    for (const dir of candidates) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const p = path.join(dir, probe);
        fs.writeFileSync(p, 'ok');
        fs.rmSync(p, { force: true });
        cacheDir = dir;
        break;
      } catch {
        /* try the next candidate */
      }
    }
    this.workerSourcePath = path.join(cacheDir, `materialiq-pg-executor-${process.pid}.cjs`);
    fs.writeFileSync(this.workerSourcePath, WORKER_SOURCE, { mode: 0o600 });
    this.worker = new Worker(this.workerSourcePath, {
      workerData: {
        sab: this.sab,
        connectionString: this.connectionString,
        sslConfig: this.sslConfig,
        // When the worker source lives outside the project tree (read-only
        // serverless bundles force a temp dir), plain require('pg') cannot
        // resolve; hand the worker pg's absolute package path instead.
        pgModulePath: pgModulePath(),
      },
      stdout: true,
      stderr: true,
    });
    this.worker.unref(); // never keep the process alive just for the pool
  }

  /** Send one job and BLOCK until the worker answers via shared memory. */
  private call<T = Record<string, unknown>>(job: Record<string, unknown>): T {
    this.ensureWorker();
    const view = this.view!;
    if (Atomics.load(view, 0) !== 0) throw new Error('PostgreSQL executor re-entered while a call is in flight');

    const id = this.nextId++;
    const envelope = JSON.stringify({ id, ...job });
    // Requests ride the normal message channel; the worker is free to receive.
    this.worker!.postMessage(envelope);

    // Park until the worker stores the response and notifies.
    const waited = Atomics.wait(view, 0, 0, CALL_TIMEOUT_MS);
    if (waited === 'timed-out') {
      throw new Error(`PostgreSQL call timed out after ${CALL_TIMEOUT_MS}ms`);
    }
    const length = Atomics.load(view, 1);
    const text = Buffer.from(this.payload!.buffer, this.payload!.byteOffset, length).toString('utf8');
    Atomics.store(view, 0, 0);
    Atomics.store(view, 1, 0);

    const parsed = JSON.parse(text, (_k, v) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        // timestamptz arrives as ISO-8601 TEXT — matching node:sqlite, which
        // delivers timestamps as strings. (Producing Date objects here broke
        // server components that slice/render timestamps as text.) App code
        // feeds timestamps to new Date()/String() everywhere, so TEXT is the
        // universally compatible shape.
        if (typeof v.__pgDate === 'string') return v.__pgDate;
        if (typeof v.__pgBool === 'boolean') return v.__pgBool ? 1 : 0;
        if (typeof v.__pgJson === 'string') return v.__pgJson;
        if (typeof v.__pgNum === 'string') return Number(v.__pgNum);
      }
      return v;
    }) as { ok: boolean; error?: string } & Record<string, unknown>;
    if (!parsed.ok) throw new Error(parsed.error || 'PostgreSQL error');
    return parsed as T;
  }

  prepare(rawSql: string): PreparedStatementApi {
    const sql = convertPlaceholders(translateStatement(rawSql, 'postgresql'));
    // SQLite DataApi contract emulation: run() on an INSERT into an identity
    // table must surface the generated key as lastInsertRowid. Only those
    // INSERTs are rewritten (RETURNING id appended); every other statement —
    // and every non-identity table — keeps the exact translated SQL and the
    // exact previous run() result shape.
    const stripped = rawSql.trimEnd().replace(/;\s*$/, '');
    // Defensive: a statement that already carries RETURNING (e.g. a test or
    // service using INSERT ... RETURNING id explicitly and calling run()) is
    // never double-appended.
    const suffix = /\breturning\b/i.test(stripped) ? null : returningIdSuffix(stripped);
    const runSql = suffix
      ? convertPlaceholders(translateStatement(stripped + suffix, 'postgresql'))
      : sql;
    const executor = this;
    return {
      run(...params: unknown[]): RunResult {
        const res = executor.call<{ rowCount: number; rows?: Array<Record<string, unknown>> }>(
          executor.activeSession === null
            ? { op: 'query', sql: runSql, params }
            : { op: 'txn-query', session: executor.activeSession, sql: runSql, params }
        );
        // RETURNING id yields exactly one row for a successful identity INSERT
        // (and zero rows when ON CONFLICT DO NOTHING skips) — the generated or
        // explicit id becomes lastInsertRowid; 0 otherwise, as before.
        const returned = res.rows && res.rows.length > 0 ? res.rows[0] : undefined;
        const rowid = returned && returned.id != null ? Number(returned.id) : 0;
        return {
          changes: res.rowCount ?? 0,
          lastInsertRowid: Number.isFinite(rowid) ? rowid : 0,
        };
      },
      get(...params: unknown[]): unknown {
        const res = executor.call<{ rows: Array<Record<string, unknown>> }>(
          executor.activeSession === null
            ? { op: 'query', sql, params }
            : { op: 'txn-query', session: executor.activeSession, sql, params }
        );
        return res.rows && res.rows.length > 0 ? res.rows[0] : undefined;
      },
      all(...params: unknown[]): unknown[] {
        const res = executor.call<{ rows: Array<Record<string, unknown>> }>(
          executor.activeSession === null
            ? { op: 'query', sql, params }
            : { op: 'txn-query', session: executor.activeSession, sql, params }
        );
        return res.rows ?? [];
      },
    };
  }

  exec(rawSql: string): void {
    // DDL / administrative statements; never part of a session transaction.
    const sql = convertPlaceholders(translateStatement(rawSql, 'postgresql'));
    this.call({ op: 'query', sql, params: [] });
  }

  // -- transaction session API (used by withTransaction on the PG path) ----

  beginTransaction(): number {
    const res = this.call<{ sessionId: number }>({ op: 'txn-begin' });
    this.activeSession = res.sessionId;
    return res.sessionId;
  }

  commitTransaction(session: number): void {
    try {
      this.call({ op: 'txn-commit', session });
    } finally {
      if (this.activeSession === session) this.activeSession = null;
    }
  }

  rollbackTransaction(session: number): void {
    try {
      this.call({ op: 'txn-rollback', session });
    } finally {
      if (this.activeSession === session) this.activeSession = null;
    }
  }

  /** Terminate the worker and close the pool (tests / graceful shutdown). */
  close(): void {
    this.closed = true;
    this.activeSession = null;
    if (this.worker) {
      try {
        this.call({ op: 'end' });
      } catch {
        /* pool already gone */
      }
      this.worker.terminate();
      this.worker = null;
    }
    if (this.workerSourcePath) {
      try {
        require('node:fs').rmSync(this.workerSourcePath, { force: true });
      } catch {
        /* best effort */
      }
      this.workerSourcePath = null;
    }
  }
}
