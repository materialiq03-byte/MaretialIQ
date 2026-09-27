/**
 * Central runtime configuration. Every tunable is read from the environment
 * (with a safe default) — nothing is hardcoded in components or services.
 */
import path from 'node:path';

function int(value: string | undefined, fallback: number): number {
  const n = value ? parseInt(value, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  /**
   * SIH prototype mode: authentication is intentionally bypassed. Every
   * request gets a full-permission prototype identity — no login page, no
   * redirects, access to all five demo CPSEs. Set REQUIRE_AUTH=true to
   * restore the normal login/session flow (all auth code stays in place).
   * PROTOTYPE-ONLY: this configuration is not production security.
   */
  prototypeMode: process.env.REQUIRE_AUTH !== 'true',
  dataDir: process.env.DATA_DIR ?? path.join(process.cwd(), 'data'),
  dbPath: process.env.DB_PATH ?? '', // resolved in db/client via dataDir
  pageSize: { default: int(process.env.DEFAULT_PAGE_SIZE, 10), max: int(process.env.MAX_PAGE_SIZE, 100) },
  matching: {
    fuzzyThreshold: int(process.env.MATCH_FUZZY_THRESHOLD, 55),
    criticalPenalty: int(process.env.MATCH_CRITICAL_PENALTY, 25),
    criticalCategories: (process.env.MATCH_CRITICAL_ATTRIBUTES ?? 'seal_type,voltage_rating,pressure_class,bore_diameter')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  pipeline: {
    // Step 12: per-format upload limits. CSV is the recommended enterprise
    // format (parsed incrementally record-by-record through the bounded
    // streaming analyze + chunked import jobs) so its limit is far higher;
    // XLSX parsing materializes the whole workbook (memory-sensitive) and
    // keeps a conservative safety limit.
    maxCsvImportMb: int(process.env.IMPORT_MAX_CSV_MB, 50),
    maxXlsxImportMb: int(process.env.IMPORT_MAX_XLSX_MB, 5),
    // Legacy single limit: kept as the fallback for MAX_IMPORT_FILE_MB and
    // resolved per-format below so old deployments keep working unchanged.
    maxImportFileMb: int(process.env.MAX_IMPORT_FILE_MB, 5),
    // Step-4 job execution: bounded chunk size for matching-run persistence
    // (candidate pairs committed per transaction) and the staleness window
    // after which an interrupted RUNNING job is recoverable.
    matchingChunkSize: int(process.env.MATCHING_CHUNK_SIZE, 5000),
    jobHeartbeatTimeoutSec: int(process.env.JOB_HEARTBEAT_TIMEOUT_SEC, 120),
    // Attribute names whose extraction is flagged critical (mirrors matching.criticalCategories).
    criticalAttributes: (process.env.MATCH_CRITICAL_ATTRIBUTES ?? 'seal_type,voltage_rating,pressure_class,bore_diameter')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  demo: {
    label: process.env.DEMO_DATA_LABEL ?? 'Demonstration environment using representative material records',
    /** Banner shown while prototype mode is active. */
    prototypeBadge: 'SIH 2026 · Prototype Environment',
  },
} as const;

/** Per-format upload limit (Step 12): CSV and XLSX have different scaling
 *  characteristics and therefore different limits. CSV is streamed/bounded;
 *  XLSX is memory-bound and keeps a conservative cap. A deployment that set
 *  the legacy MAX_IMPORT_FILE_MB keeps its old value for BOTH formats. */
export function maxUploadMbFor(fileName: string): number {
  const lower = fileName.toLowerCase();
  const isXlsx = lower.endsWith('.xlsx') || lower.endsWith('.xls');
  // MAX_IMPORT_FILE_MB is honored live (not baked in at module load) so
  // deployments and tests can override per environment.
  const legacy = process.env.MAX_IMPORT_FILE_MB;
  if (legacy !== undefined && legacy !== '') {
    const n = parseInt(legacy, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return isXlsx ? config.pipeline.maxXlsxImportMb : config.pipeline.maxCsvImportMb;
}

export type AppConfig = typeof config;
