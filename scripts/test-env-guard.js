/**
 * Step 11 incident guard: the local test suite must never inherit a
 * PostgreSQL-targeting environment.
 *
 * During Step 11, an exported MATERIALIQ_DB_DIALECT=postgres +
 * MATERIALIQ_DATABASE_URL leaked into `npm test` and the import suite wrote
 * test rows into production Supabase (incident report: Step 11, section Q).
 * This guard fails the run BEFORE any test executes when those variables are
 * present in the environment of the npm invocation.
 *
 * The gated Supabase integration suite intentionally sets these variables in
 * ITS OWN command (tests/pg-integration.test.ts is not part of `npm test`),
 * so this guard never blocks it — it only protects the default local suite,
 * which always runs against injected temp SQLite databases.
 */
const OFFENDING = [
  'MATERIALIQ_DB_DIALECT',
  'MATERIALIQ_DATABASE_URL',
  'MATERIALIQ_PG_SSL',
  'MATERIALIQ_RUN_PG_TESTS',
];

const present = OFFENDING.filter((k) => process.env[k] !== undefined);

if (present.length > 0) {
  console.error('\n==============================================');
  console.error('TEST ENV GUARD: refusing to run the local test suite.');
  console.error('');
  console.error('Database-targeting environment variables are set:');
  for (const k of present) {
    console.error(`  - ${k}=<value hidden>`);
  }
  console.error('');
  console.error('The local suite must run against its own temp SQLite');
  console.error('databases — inheriting a PostgreSQL target can write');
  console.error('test rows into the production database (Step 11 incident).');
  console.error('');
  console.error('Fix: run the suite in a clean environment, e.g.');
  console.error('  env -u MATERIALIQ_DB_DIALECT -u MATERIALIQ_DATABASE_URL \\');
  console.error('      -u MATERIALIQ_PG_SSL -u MATERIALIQ_RUN_PG_TESTS npm test');
  console.error('');
  console.error('(The Supabase integration suite sets these variables itself');
  console.error('and is invoked directly via npx tsx tests/pg-integration.test.ts.)');
  console.error('==============================================\n');
  process.exit(1);
}

console.log('test-env-guard: clean environment (no PG-targeting vars) — proceeding.');
