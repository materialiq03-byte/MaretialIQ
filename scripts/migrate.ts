/**
 * Apply pending migrations to the SQLite database. Run via `npm run db:migrate`.
 */
import { getRawSqliteDb } from '../src/lib/db/client';
import { migrate } from '../src/lib/db/migrate';
import { seedRunsFromJsonMirror } from '../src/lib/matching/run-history';

const db = getRawSqliteDb();
const applied = migrate(db);
if (applied.length === 0) {
  console.log('Database schema is up to date.');
} else {
  console.log(`Applied migrations: ${applied.join(', ')}`);
}
// After the evaluation_runs table exists, make sure any runs that only live in
// the JSON mirror (e.g. the seeded pre-Step-13 history) are preserved in the DB.
if (applied.includes(8)) {
  const seeded = seedRunsFromJsonMirror();
  console.log(`evaluation_runs: seeded ${seeded} run(s) from data/evaluation/run-history.json`);
}
