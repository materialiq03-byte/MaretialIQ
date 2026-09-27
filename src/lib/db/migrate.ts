/**
 * Versioned migrations. Each migration runs once inside a transaction and is
 * recorded in _migrations. Applied automatically on server start.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

const TIMESTAMP_DDL = `created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

const MATCH_CANDIDATES_DDL = `
  CREATE TABLE {TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_material_id INTEGER NOT NULL REFERENCES material_records(id),
    candidate_material_id INTEGER NOT NULL REFERENCES material_records(id),
    semantic_score REAL NOT NULL DEFAULT 0 CHECK (semantic_score BETWEEN 0 AND 100),
    fuzzy_score REAL NOT NULL DEFAULT 0 CHECK (fuzzy_score BETWEEN 0 AND 100),
    technical_score REAL NOT NULL DEFAULT 0 CHECK (technical_score BETWEEN 0 AND 100),
    category_compatible INTEGER NOT NULL DEFAULT 1 CHECK (category_compatible IN (0,1)),
    final_score REAL NOT NULL DEFAULT 0 CHECK (final_score BETWEEN 0 AND 100),
    match_type TEXT NOT NULL DEFAULT 'needs_review'
      CHECK (match_type IN ('identical','near_duplicate','functional_equivalent','needs_review','different')),
    explanation TEXT NOT NULL DEFAULT '',
    critical_difference TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','approved','rejected','deferred')),
    ${TIMESTAMP_DDL},
    UNIQUE (source_material_id, candidate_material_id),
    CHECK (source_material_id <> candidate_material_id)
  );`;

const MATCH_INDEXES_DDL = `
  CREATE INDEX IF NOT EXISTS idx_match_source ON {TABLE}(source_material_id);
  CREATE INDEX IF NOT EXISTS idx_match_candidate ON {TABLE}(candidate_material_id);
  CREATE INDEX IF NOT EXISTS idx_match_status ON {TABLE}(status);
  CREATE INDEX IF NOT EXISTS idx_match_type ON {TABLE}(match_type);`;

export const MIGRATIONS: Migration[] = [
  {
    // Step 15 - procurement opportunity detection. Opportunities are PERSISTED
    // (not dynamically derived) because humans acknowledge/dismiss/resolve
    // them (section 40B): the table stores the governed workflow state and an
    // explainable evidence summary - never a copy of procurement rows.
    // detection_key is UNIQUE and deterministic
    // (type + cmi/org/material/supplier + period), so re-running detection is
    // idempotent; human status is never reset by detection reruns.
    version: 15,
    name: 'procurement-opportunities',
    up: (db) => {
      db.exec(`
        CREATE TABLE procurement_opportunities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          opportunity_type TEXT NOT NULL CHECK (opportunity_type IN (
            'CROSS_CPSE_DEMAND','REPEATED_PROCUREMENT','FRAGMENTED_DEMAND',
            'UNHARMONIZED_RELATED_PROCUREMENT','MULTI_SUPPLIER_ACTIVITY',
            'HIGH_PROCUREMENT_ACTIVITY')),
          status TEXT NOT NULL DEFAULT 'OPEN'
            CHECK (status IN ('OPEN','ACKNOWLEDGED','DISMISSED','RESOLVED')),
          -- Deterministic identity (section 17/32): repeated detection runs
          -- upsert on this key and never duplicate OPEN opportunities.
          detection_key TEXT NOT NULL UNIQUE,
          cmi_id INTEGER REFERENCES common_materials(id),
          organization_id INTEGER REFERENCES organizations(id),
          supplier_id INTEGER REFERENCES suppliers(id),
          material_id INTEGER REFERENCES material_records(id),
          period_start TEXT,
          period_end TEXT,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          -- Explainable evidence summary (counts, per-UOM demand, per-currency
          -- spend, rule factors) - a bounded JSON blob, NOT procurement data.
          evidence TEXT NOT NULL DEFAULT '{}',
          priority_signal INTEGER NOT NULL DEFAULT 0 CHECK (priority_signal >= 0),
          reviewed_by TEXT,
          reviewed_at TEXT,
          review_note TEXT,
          ${TIMESTAMP_DDL},
          CHECK (review_note IS NULL OR reviewed_by IS NOT NULL)
        );
        CREATE INDEX idx_opp_status ON procurement_opportunities(status);
        CREATE INDEX idx_opp_type ON procurement_opportunities(opportunity_type);
        CREATE INDEX idx_opp_cmi ON procurement_opportunities(cmi_id);
        CREATE INDEX idx_opp_org ON procurement_opportunities(organization_id);
        CREATE INDEX idx_opp_created ON procurement_opportunities(created_at);
      `);

      // Extend the audit action CHECK with the opportunity review lifecycle
      // (same rebuild pattern as migrations 3, 6, 7, 11, 13 and 14).
      db.exec(`
        CREATE TABLE audit_logs_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL CHECK (action IN (
            'material_created','material_updated','material_reprocessed','import_performed','match_generated',
            'proposal_created','proposal_approved','proposal_rejected','proposal_deferred',
            'mapping_created','common_material_created','user_login','user_login_failed','user_logout','user_created',
            'user_updated','user_role_changed','demo_role_switched',
            'import_created','import_started','import_failed','import_retried',
            'procurement_created','procurement_updated','supplier_created',
            'procurement_import_started','procurement_import_completed','procurement_import_failed',
            'procurement_opportunity_acknowledged','procurement_opportunity_dismissed',
            'procurement_opportunity_resolved','procurement_opportunity_reopened'
          )),
          entity_type TEXT NOT NULL,
          entity_id INTEGER,
          actor TEXT NOT NULL DEFAULT 'system',
          details TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        INSERT INTO audit_logs_new (id, action, entity_type, entity_id, actor, details, created_at)
          SELECT id, action, entity_type, entity_id, actor, details, created_at FROM audit_logs;
        DROP TABLE audit_logs;
        ALTER TABLE audit_logs_new RENAME TO audit_logs;
        CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor, created_at);
      `);
    },
  },
  {
    // Step 13 - procurement ingestion. Reuses the generic import-job
    // machinery (import_runs / import_run_chunks / single-active guard);
    // adds ONLY procurement-specific staging + idempotency:
    //   - import_runs.kind: which executor a job runs (frozen rows default
    //     'materials', so existing jobs are untouched);
    //   - procurement_import_rows: typed staging (import_rows keeps its
    //     frozen material shape);
    //   - uq_procurement_row_signature: deterministic re-import guard - a
    //     repeated upload of the SAME purchase line is skipped, while
    //     legitimate repeated purchases (different PO/date/qty) import;
    //   - audit actions for the procurement import lifecycle.
    version: 14,
    name: 'procurement-import',
    up: (db) => {
      db.exec(`
        ALTER TABLE import_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'materials'
          CHECK (kind IN ('materials','procurement'));

        CREATE TABLE procurement_import_rows (
          job_id TEXT NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
          row_number INTEGER NOT NULL CHECK (row_number >= 1),
          severity TEXT NOT NULL CHECK (severity IN ('VALID','WARNING','ERROR')),
          org_code TEXT NOT NULL DEFAULT '',
          material_code TEXT NOT NULL DEFAULT '',
          cmi_code TEXT,
          supplier_code TEXT NOT NULL DEFAULT '',
          purchase_order_reference TEXT NOT NULL DEFAULT '',
          purchase_date TEXT NOT NULL DEFAULT '',
          delivery_date TEXT,
          quantity TEXT NOT NULL DEFAULT '',
          uom TEXT NOT NULL DEFAULT '',
          unit_price TEXT,
          currency TEXT,
          plant_location TEXT,
          status TEXT,
          row_signature TEXT NOT NULL DEFAULT '',
          ${TIMESTAMP_DDL},
          PRIMARY KEY (job_id, row_number)
        );
        CREATE INDEX idx_proc_import_rows_job ON procurement_import_rows(job_id);

        -- Deterministic idempotency (Step 13 sections 12/19): the SHA-256
        -- signature of the FULL source line (Section 12 forbids a bare
        -- organization+material key - legitimate repeated purchases must
        -- import). The DB unique index is the final authority behind the
        -- executor's batched pre-check.
        ALTER TABLE procurement_records ADD COLUMN row_signature TEXT NOT NULL DEFAULT '';

        CREATE UNIQUE INDEX IF NOT EXISTS uq_procurement_row_signature
          ON procurement_records(row_signature) WHERE row_signature <> '';
      `);

      // Extend the audit action CHECK with the procurement import lifecycle
      // (same rebuild pattern as migrations 3, 6, 7, 11 and 13).
      db.exec(`
        CREATE TABLE audit_logs_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL CHECK (action IN (
            'material_created','material_updated','material_reprocessed','import_performed','match_generated',
            'proposal_created','proposal_approved','proposal_rejected','proposal_deferred',
            'mapping_created','common_material_created','user_login','user_login_failed','user_logout','user_created',
            'user_updated','user_role_changed','demo_role_switched',
            'import_created','import_started','import_failed','import_retried',
            'procurement_created','procurement_updated','supplier_created',
            'procurement_import_started','procurement_import_completed','procurement_import_failed'
          )),
          entity_type TEXT NOT NULL,
          entity_id INTEGER,
          actor TEXT NOT NULL DEFAULT 'system',
          details TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        INSERT INTO audit_logs_new (id, action, entity_type, entity_id, actor, details, created_at)
          SELECT id, action, entity_type, entity_id, actor, details, created_at FROM audit_logs;
        DROP TABLE audit_logs;
        ALTER TABLE audit_logs_new RENAME TO audit_logs;
        CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor, created_at);
      `);
    },
  },
  {
    version: 13,
    name: 'procurement-foundation',
    up: (db) => {
      // Step 12 - procurement DATA FOUNDATION. Separate domain from matching:
      // suppliers + procurement records that may reference (but never create
      // or infer) Common Material Identities. cmi_id is NULLABLE - only
      // materials whose human-approved mapping exists carry it, and the
      // service layer validates material->CMI consistency against the
      // authoritative material_mappings table. UOM is preserved verbatim
      // (no conversion); unit_price is TEXT to keep exact decimal values
      // (SQLite has no decimal type; the service layer validates the format).
      db.exec(`
        CREATE TABLE suppliers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          supplier_code TEXT NOT NULL UNIQUE,
          supplier_name TEXT NOT NULL,
          region TEXT,
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
          ${TIMESTAMP_DDL}
        );

        CREATE TABLE procurement_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          organization_id INTEGER NOT NULL REFERENCES organizations(id),
          material_id INTEGER NOT NULL REFERENCES material_records(id),
          cmi_id INTEGER REFERENCES common_materials(id),
          supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
          purchase_order_reference TEXT NOT NULL,
          purchase_date TEXT NOT NULL,
          delivery_date TEXT,
          -- TEXT keeps exact decimal digits (no float); CAST makes the positivity
          -- check real (SQLite orders all TEXT above all numbers).
          quantity TEXT NOT NULL CHECK (CAST(quantity AS REAL) > 0),
          uom TEXT NOT NULL CHECK (length(uom) BETWEEN 1 AND 12),
          unit_price TEXT,
          currency TEXT,
          plant_location TEXT,
          procurement_status TEXT NOT NULL
            CHECK (procurement_status IN ('ORDERED','PARTIALLY_DELIVERED','DELIVERED','CANCELLED')),
          source_system TEXT,
          ${TIMESTAMP_DDL},
          CHECK (
            (unit_price IS NULL AND currency IS NULL)
            OR (unit_price IS NOT NULL AND currency IS NOT NULL)
          )
        );
        CREATE INDEX idx_proc_org ON procurement_records(organization_id);
        CREATE INDEX idx_proc_material ON procurement_records(material_id);
        CREATE INDEX idx_proc_cmi ON procurement_records(cmi_id);
        CREATE INDEX idx_proc_supplier ON procurement_records(supplier_id);
        CREATE INDEX idx_proc_date ON procurement_records(purchase_date);
        CREATE INDEX idx_proc_cmi_date ON procurement_records(cmi_id, purchase_date);
        CREATE INDEX idx_proc_org_date ON procurement_records(organization_id, purchase_date);
      `);

      // Audit: procurement lifecycle events. Rebuild for the extended action
      // CHECK (same pattern as migrations 3, 6, 7 and 11).
      db.exec(`
        CREATE TABLE audit_logs_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL CHECK (action IN (
            'material_created','material_updated','material_reprocessed','import_performed','match_generated',
            'proposal_created','proposal_approved','proposal_rejected','proposal_deferred',
            'mapping_created','common_material_created','user_login','user_login_failed','user_logout','user_created',
            'user_updated','user_role_changed','demo_role_switched',
            'import_created','import_started','import_failed','import_retried',
            'procurement_created','procurement_updated','supplier_created'
          )),
          entity_type TEXT NOT NULL,
          entity_id INTEGER,
          actor TEXT NOT NULL DEFAULT 'system',
          details TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        INSERT INTO audit_logs_new (id, action, entity_type, entity_id, actor, details, created_at)
          SELECT id, action, entity_type, entity_id, actor, details, created_at FROM audit_logs;
        DROP TABLE audit_logs;
        ALTER TABLE audit_logs_new RENAME TO audit_logs;
        CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor, created_at);
      `);
    },
  },
  {
    version: 12,
    name: 'repair-matching-runs-active-guard',
    up: (db) => {
      // Step-6B drift repair. Step 4's v10 defined uq_matching_runs_active in
      // code, but it never materialized on the production database file
      // (v10 was recorded as applied before the index statement existed, so
      // re-running the runner could not heal it). v10 itself is FROZEN and is
      // NOT edited retroactively; this migration adds only the missing
      // DB-authoritative guard: at most one matching run may be QUEUED or
      // RUNNING at any time. IF NOT EXISTS keeps the migration idempotent and
      // a no-op on databases that already carry the index.
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_matching_runs_active
          ON matching_runs((1))
          WHERE status IN ('QUEUED', 'RUNNING');
      `);
    },
  },
  {
    version: 1,
    name: 'core-domain-schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE organizations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 2 AND 10),
          name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
          description TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
          ${TIMESTAMP_DDL}
        );

        CREATE TABLE data_imports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          organization_id INTEGER NOT NULL REFERENCES organizations(id),
          file_name TEXT NOT NULL,
          file_type TEXT NOT NULL CHECK (file_type IN ('csv','xlsx')),
          total_rows INTEGER NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
          successful_rows INTEGER NOT NULL DEFAULT 0 CHECK (successful_rows >= 0),
          failed_rows INTEGER NOT NULL DEFAULT 0 CHECK (failed_rows >= 0),
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','processing','completed','failed')),
          error_info TEXT,
          ${TIMESTAMP_DDL}
        );
        CREATE INDEX idx_imports_org ON data_imports(organization_id);
        CREATE INDEX idx_imports_status ON data_imports(status);

        CREATE TABLE material_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          organization_id INTEGER NOT NULL REFERENCES organizations(id),
          original_code TEXT NOT NULL,
          original_description TEXT NOT NULL,
          normalized_description TEXT,
          category TEXT NOT NULL,
          subcategory TEXT,
          manufacturer TEXT,
          model TEXT,
          part_number TEXT,
          material_type TEXT,
          uom TEXT NOT NULL DEFAULT 'NOS',
          import_id INTEGER REFERENCES data_imports(id) ON DELETE SET NULL,
          processing_status TEXT NOT NULL DEFAULT 'imported'
            CHECK (processing_status IN ('imported','normalised','validated')),
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
          ${TIMESTAMP_DDL},
          UNIQUE (organization_id, original_code)
        );
        CREATE INDEX idx_material_org ON material_records(organization_id);
        CREATE INDEX idx_material_category ON material_records(category);
        CREATE INDEX idx_material_status ON material_records(processing_status);
        CREATE INDEX idx_material_import ON material_records(import_id);

        CREATE TABLE material_attributes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          material_id INTEGER NOT NULL REFERENCES material_records(id) ON DELETE CASCADE,
          attribute_name TEXT NOT NULL CHECK (length(attribute_name) BETWEEN 2 AND 60),
          value TEXT NOT NULL,
          normalized_value TEXT,
          unit TEXT,
          is_critical INTEGER NOT NULL DEFAULT 0 CHECK (is_critical IN (0,1)),
          ${TIMESTAMP_DDL},
          UNIQUE (material_id, attribute_name)
        );
        CREATE INDEX idx_attributes_material ON material_attributes(material_id);
        CREATE INDEX idx_attributes_name_value ON material_attributes(attribute_name, normalized_value);

        ${MATCH_CANDIDATES_DDL.replace('{TABLE}', 'match_candidates')}
        ${MATCH_INDEXES_DDL.replace(/\{TABLE\}/g, 'match_candidates')}

        CREATE TABLE match_decisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          match_id INTEGER NOT NULL REFERENCES match_candidates(id),
          decision TEXT NOT NULL CHECK (decision IN ('approved','rejected','deferred','sent_for_review')),
          reviewer TEXT NOT NULL,
          comment TEXT,
          decided_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          ${TIMESTAMP_DDL}
        );
        CREATE INDEX idx_decisions_match ON match_decisions(match_id);

        CREATE TABLE review_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          match_id INTEGER NOT NULL UNIQUE REFERENCES match_candidates(id),
          priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
          reason TEXT NOT NULL,
          critical_difference TEXT,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
          assigned_reviewer TEXT,
          opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          resolved_at TEXT,
          ${TIMESTAMP_DDL}
        );
        CREATE INDEX idx_queue_status_priority ON review_queue(status, priority);

        CREATE TABLE common_materials (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          description TEXT,
          category TEXT NOT NULL,
          source_match_id INTEGER REFERENCES match_candidates(id),
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
          ${TIMESTAMP_DDL}
        );

        CREATE TABLE material_mappings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cmi_id INTEGER NOT NULL REFERENCES common_materials(id),
          material_id INTEGER NOT NULL UNIQUE REFERENCES material_records(id),
          organization_id INTEGER NOT NULL REFERENCES organizations(id),
          ${TIMESTAMP_DDL}
        );
        CREATE INDEX idx_mappings_cmi ON material_mappings(cmi_id);
        CREATE INDEX idx_mappings_org ON material_mappings(organization_id);

        CREATE TABLE audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL CHECK (action IN (
            'material_created','material_updated','import_performed','match_generated',
            'proposal_created','proposal_approved','proposal_rejected','proposal_deferred',
            'mapping_created'
          )),
          entity_type TEXT NOT NULL,
          entity_id INTEGER,
          actor TEXT NOT NULL DEFAULT 'system',
          details TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
        CREATE INDEX idx_audit_actor ON audit_logs(actor, created_at);
      `);
    },
  },
  {
    version: 3,
    name: 'intelligence-pipeline-fields',
    up: (db) => {
      // material_records: extend processing_status CHECK for pipeline stages
      // and add pipeline provenance columns. SQLite cannot alter a CHECK;
      // rebuild and copy.
      db.exec(`
        CREATE TABLE material_records_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          organization_id INTEGER NOT NULL REFERENCES organizations(id),
          original_code TEXT NOT NULL,
          original_description TEXT NOT NULL,
          normalized_description TEXT,
          category TEXT NOT NULL,
          subcategory TEXT,
          manufacturer TEXT,
          model TEXT,
          part_number TEXT,
          material_type TEXT,
          uom TEXT NOT NULL DEFAULT 'NOS',
          import_id INTEGER REFERENCES data_imports(id) ON DELETE SET NULL,
          processing_status TEXT NOT NULL DEFAULT 'imported'
            CHECK (processing_status IN ('imported','normalised','classified','attributes_extracted','ready_for_matching','warning','error')),
          classification_confidence REAL
            CHECK (classification_confidence IS NULL OR classification_confidence BETWEEN 0 AND 100),
          classification_source TEXT,
          quality_status TEXT
            CHECK (quality_status IN ('good','warning','incomplete','invalid')),
          quality_checks TEXT,
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
          ${TIMESTAMP_DDL},
          UNIQUE (organization_id, original_code)
        );
        INSERT INTO material_records_new
          (id, organization_id, original_code, original_description, normalized_description,
           category, subcategory, manufacturer, model, part_number, material_type, uom,
           import_id, processing_status, is_active, created_at, updated_at)
        SELECT id, organization_id, original_code, original_description, normalized_description,
           category, subcategory, manufacturer, model, part_number, material_type, uom,
           import_id,
           CASE processing_status WHEN 'validated' THEN 'attributes_extracted' ELSE processing_status END,
           is_active, created_at, updated_at
        FROM material_records;
        DROP TABLE material_records;
        ALTER TABLE material_records_new RENAME TO material_records;
        CREATE INDEX IF NOT EXISTS idx_material_org ON material_records(organization_id);
        CREATE INDEX IF NOT EXISTS idx_material_category ON material_records(category);
        CREATE INDEX IF NOT EXISTS idx_material_status ON material_records(processing_status);
        CREATE INDEX IF NOT EXISTS idx_material_import ON material_records(import_id);
        CREATE INDEX IF NOT EXISTS idx_material_quality ON material_records(quality_status);

        -- material_attributes: provenance for extracted values.
        ALTER TABLE material_attributes ADD COLUMN extraction_method TEXT NOT NULL DEFAULT 'imported'
          CHECK (extraction_method IN ('rule','manual','imported'));
        ALTER TABLE material_attributes ADD COLUMN confidence REAL
          CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100);

        -- data_imports: pipeline summary counters.
        ALTER TABLE data_imports ADD COLUMN new_rows INTEGER NOT NULL DEFAULT 0 CHECK (new_rows >= 0);
        ALTER TABLE data_imports ADD COLUMN duplicate_rows INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_rows >= 0);
        ALTER TABLE data_imports ADD COLUMN warning_rows INTEGER NOT NULL DEFAULT 0 CHECK (warning_rows >= 0);
        ALTER TABLE data_imports ADD COLUMN missing_description_rows INTEGER NOT NULL DEFAULT 0 CHECK (missing_description_rows >= 0);

        -- audit_logs: allow the reprocess action (CHECK rebuild).
        CREATE TABLE audit_logs_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL CHECK (action IN (
            'material_created','material_updated','material_reprocessed','import_performed','match_generated',
            'proposal_created','proposal_approved','proposal_rejected','proposal_deferred',
            'mapping_created'
          )),
          entity_type TEXT NOT NULL,
          entity_id INTEGER,
          actor TEXT NOT NULL DEFAULT 'system',
          details TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        INSERT INTO audit_logs_new (id, action, entity_type, entity_id, actor, details, created_at)
          SELECT id, action, entity_type, entity_id, actor, details, created_at FROM audit_logs;
        DROP TABLE audit_logs;
        ALTER TABLE audit_logs_new RENAME TO audit_logs;
        CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor, created_at);
      `);
    },
  },
  {
    version: 4,
    name: 'match-evidence',
    up: (db) => {
      db.exec(`
        ALTER TABLE match_candidates ADD COLUMN evidence TEXT;
        ALTER TABLE match_candidates ADD COLUMN match_run_id TEXT;
        CREATE INDEX IF NOT EXISTS idx_match_run ON match_candidates(match_run_id);
      `);
    },
  },
  {
    version: 5,
    name: 'import-workflow',
    up: (db) => {
      db.exec(`
        -- Import Center lifecycle: fine-grained workflow status kept alongside
        -- the coarse legacy status (which remains valid and consumed elsewhere).
        ALTER TABLE data_imports ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'completed'
          CHECK (workflow_status IN ('uploaded','validating','ready','importing','completed','completed_with_warnings','failed'));
        ALTER TABLE data_imports ADD COLUMN valid_rows INTEGER NOT NULL DEFAULT 0 CHECK (valid_rows >= 0);
        ALTER TABLE data_imports ADD COLUMN error_rows INTEGER NOT NULL DEFAULT 0 CHECK (error_rows >= 0);
        ALTER TABLE data_imports ADD COLUMN empty_rows INTEGER NOT NULL DEFAULT 0 CHECK (empty_rows >= 0);
        ALTER TABLE data_imports ADD COLUMN imported_rows INTEGER NOT NULL DEFAULT 0 CHECK (imported_rows >= 0);
        ALTER TABLE data_imports ADD COLUMN skipped_existing_rows INTEGER NOT NULL DEFAULT 0 CHECK (skipped_existing_rows >= 0);
        ALTER TABLE data_imports ADD COLUMN updated_rows INTEGER NOT NULL DEFAULT 0 CHECK (updated_rows >= 0);
        ALTER TABLE data_imports ADD COLUMN column_mapping TEXT;
        ALTER TABLE data_imports ADD COLUMN row_report TEXT;
        ALTER TABLE data_imports ADD COLUMN duplicate_strategy TEXT
          CHECK (duplicate_strategy IS NULL OR duplicate_strategy IN ('skip','update'));
        ALTER TABLE data_imports ADD COLUMN validated_at TEXT;
        ALTER TABLE data_imports ADD COLUMN imported_at TEXT;

        -- Traceability: which spreadsheet row a material came from.
        ALTER TABLE material_records ADD COLUMN source_row INTEGER;
        CREATE INDEX IF NOT EXISTS idx_material_source_row ON material_records(source_row);
      `);
    },
  },
  {
    version: 2,
    name: 'rebuild-match-candidates-constraints',
    up: (db) => {
      // SQLite cannot alter CHECK constraints; rebuild and copy.
      db.exec(`
        ${MATCH_CANDIDATES_DDL.replace('{TABLE}', 'match_candidates_new')};
        INSERT INTO match_candidates_new
          (id, source_material_id, candidate_material_id, semantic_score, fuzzy_score,
           technical_score, category_compatible, final_score, match_type, explanation,
           critical_difference, status, created_at, updated_at)
        SELECT id, source_material_id, candidate_material_id, semantic_score, fuzzy_score,
           technical_score, category_compatible, final_score, match_type, explanation,
           critical_difference, status, created_at, updated_at
        FROM match_candidates;
        DROP TABLE match_candidates;
        ALTER TABLE match_candidates_new RENAME TO match_candidates;
        ${MATCH_INDEXES_DDL.replace(/\{TABLE\}/g, 'match_candidates')}
      `);
    },
  },
  {
    version: 6,
    name: 'auth-users-sessions',
    up: (db) => {
      db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
          email TEXT NOT NULL UNIQUE CHECK (length(email) BETWEEN 5 AND 200),
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('cpse_material_manager','cpse_technical_reviewer','authority','platform_admin')),
          organization_id INTEGER REFERENCES organizations(id),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
          last_login_at TEXT,
          ${TIMESTAMP_DDL},
          CHECK (
            (role IN ('cpse_material_manager','cpse_technical_reviewer') AND organization_id IS NOT NULL)
            OR role IN ('authority','platform_admin')
          )
        );
        CREATE INDEX idx_users_org ON users(organization_id);
        CREATE INDEX idx_users_role ON users(role);

        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          expires_at TEXT NOT NULL,
          created_via TEXT NOT NULL DEFAULT 'login' CHECK (created_via IN ('login','demo_switch')),
          demo_of_user_id INTEGER REFERENCES users(id),
          CHECK (expires_at > created_at)
        );
        CREATE INDEX idx_sessions_user ON sessions(user_id);
        CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

        -- Audit: security events. Rebuild for the extended action CHECK.
        CREATE TABLE audit_logs_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL CHECK (action IN (
            'material_created','material_updated','material_reprocessed','import_performed','match_generated',
            'proposal_created','proposal_approved','proposal_rejected','proposal_deferred',
            'mapping_created','user_login','user_login_failed','user_logout','user_created',
            'user_updated','user_role_changed','demo_role_switched'
          )),
          entity_type TEXT NOT NULL,
          entity_id INTEGER,
          actor TEXT NOT NULL DEFAULT 'system',
          details TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        INSERT INTO audit_logs_new (id, action, entity_type, entity_id, actor, details, created_at)
          SELECT id, action, entity_type, entity_id, actor, details, created_at FROM audit_logs;
        DROP TABLE audit_logs;
        ALTER TABLE audit_logs_new RENAME TO audit_logs;
        CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor, created_at);
      `);
    },
  },
  {
    version: 7,
    name: 'audit-common-material-created',
    up: (db) => {
      // Extend the audit action CHECK with a dedicated common-material-creation
      // event so CMI governance is distinguishable from its member mappings in
      // the audit trail. Same rebuild pattern as migrations 3 and 6.
      db.exec(`
        CREATE TABLE audit_logs_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL CHECK (action IN (
            'material_created','material_updated','material_reprocessed','import_performed','match_generated',
            'proposal_created','proposal_approved','proposal_rejected','proposal_deferred',
            'mapping_created','common_material_created','user_login','user_login_failed','user_logout','user_created',
            'user_updated','user_role_changed','demo_role_switched'
          )),
          entity_type TEXT NOT NULL,
          entity_id INTEGER,
          actor TEXT NOT NULL DEFAULT 'system',
          details TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        INSERT INTO audit_logs_new (id, action, entity_type, entity_id, actor, details, created_at)
          SELECT id, action, entity_type, entity_id, actor, details, created_at FROM audit_logs;
        DROP TABLE audit_logs;
        ALTER TABLE audit_logs_new RENAME TO audit_logs;
        CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor, created_at);
      `);
    },
  },
  {
    version: 8,
    name: 'evaluation-runs',
    up: (db) => {
      // Durable evaluation-run history (source of truth for /evaluation's run
      // history). The JSON file data/evaluation/run-history.json remains as a
      // human-readable mirror/fallback seeded from the same records. Append-only:
      // rows are never updated or deleted.
      db.exec(`
        CREATE TABLE evaluation_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL UNIQUE,
          timestamp TEXT NOT NULL,
          dataset TEXT NOT NULL,
          dataset_version TEXT NOT NULL,
          pairs INTEGER NOT NULL CHECK (pairs >= 0),
          accuracy REAL NOT NULL,
          macro_precision REAL NOT NULL,
          macro_recall REAL NOT NULL,
          macro_f1 REAL NOT NULL,
          weighted_f1 REAL NOT NULL,
          confusion TEXT NOT NULL,
          false_positives INTEGER NOT NULL CHECK (false_positives >= 0),
          false_negatives INTEGER NOT NULL CHECK (false_negatives >= 0),
          conflict_detected INTEGER NOT NULL CHECK (conflict_detected >= 0),
          conflict_expected INTEGER NOT NULL CHECK (conflict_expected >= 0),
          conflict_rate REAL NOT NULL,
          review_rate REAL NOT NULL,
          matcher_config TEXT NOT NULL,
          build_id TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          ${TIMESTAMP_DDL}
        );
        CREATE INDEX idx_eval_runs_time ON evaluation_runs(timestamp);
      `);
    },
  },
  {
    version: 10,
    name: 'matching-jobs',
    up: (db) => {
      // Step-4 reliability hardening: an internal job table so matching runs
      // execute in bounded, independently-committed chunks with observable
      // progress and a DB-authoritative single-active-run guard (SQLite is
      // single-writer). No business tables are touched; upsert/queue semantics
      // in match_candidates/review_queue are unchanged.
      db.exec(`
        CREATE TABLE matching_runs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'QUEUED'
            CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED')),
          total_candidates INTEGER NOT NULL DEFAULT 0 CHECK (total_candidates >= 0),
          processed_candidates INTEGER NOT NULL DEFAULT 0 CHECK (processed_candidates >= 0),
          successful_candidates INTEGER NOT NULL DEFAULT 0 CHECK (successful_candidates >= 0),
          failed_candidates INTEGER NOT NULL DEFAULT 0 CHECK (failed_candidates >= 0),
          chunk_size INTEGER NOT NULL CHECK (chunk_size >= 1),
          started_at TEXT,
          completed_at TEXT,
          heartbeat_at TEXT,
          error_message TEXT,
          ${TIMESTAMP_DDL}
        );
        CREATE INDEX idx_match_runs_status ON matching_runs(status);
        CREATE INDEX idx_match_runs_heartbeat ON matching_runs(heartbeat_at);

        CREATE TABLE matching_run_chunks (
          run_id TEXT NOT NULL REFERENCES matching_runs(id),
          chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
          first_pair INTEGER NOT NULL CHECK (first_pair >= 0),
          pair_count INTEGER NOT NULL CHECK (pair_count >= 0),
          status TEXT NOT NULL DEFAULT 'PENDING'
            CHECK (status IN ('PENDING','RUNNING','COMMITTED','FAILED')),
          ${TIMESTAMP_DDL},
          PRIMARY KEY (run_id, chunk_index)
        );

        -- DB-authoritative single-active-run guard: a constant-expression
        -- partial unique index permits at most one QUEUED/RUNNING row, so
        -- concurrent job creation fails at the database (no in-memory flag).
        CREATE UNIQUE INDEX uq_matching_runs_active
          ON matching_runs((1))
          WHERE status IN ('QUEUED', 'RUNNING');
      `);
    },
  },
  {
    version: 11,
    name: 'import-jobs',
    up: (db) => {
      // Step-5 import hardening: a durable job model so imports execute in
      // bounded, independently-committed chunks with observable progress and
      // a DB-authoritative single-active-import guard (mirrors Step-4's
      // matching_runs). Business tables are untouched; the data_imports
      // summary columns remain the durable import record.
      db.exec(`
        CREATE TABLE import_runs (
          id TEXT PRIMARY KEY,
          data_import_id INTEGER NOT NULL REFERENCES data_imports(id),
          status TEXT NOT NULL DEFAULT 'QUEUED'
            CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED')),
          filename TEXT NOT NULL,
          file_type TEXT NOT NULL,
          total_rows INTEGER NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
          processed_rows INTEGER NOT NULL DEFAULT 0 CHECK (processed_rows >= 0),
          successful_rows INTEGER NOT NULL DEFAULT 0 CHECK (successful_rows >= 0),
          failed_rows INTEGER NOT NULL DEFAULT 0 CHECK (failed_rows >= 0),
          chunk_size INTEGER NOT NULL CHECK (chunk_size >= 1),
          started_at TEXT,
          completed_at TEXT,
          heartbeat_at TEXT,
          error_message TEXT,
          ${TIMESTAMP_DDL}
        );
        CREATE INDEX idx_import_runs_status ON import_runs(status);
        CREATE INDEX idx_import_runs_import ON import_runs(data_import_id);
        CREATE INDEX idx_import_runs_heartbeat ON import_runs(heartbeat_at);

        CREATE TABLE import_run_chunks (
          run_id TEXT NOT NULL REFERENCES import_runs(id),
          chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
          first_row INTEGER NOT NULL CHECK (first_row >= 0),
          row_count INTEGER NOT NULL CHECK (row_count >= 0),
          status TEXT NOT NULL DEFAULT 'PENDING'
            CHECK (status IN ('PENDING','RUNNING','COMMITTED','FAILED')),
          error_message TEXT,
          ${TIMESTAMP_DDL},
          PRIMARY KEY (run_id, chunk_index)
        );

        CREATE TABLE import_rows (
          job_id TEXT NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
          row_number INTEGER NOT NULL CHECK (row_number >= 1),
          severity TEXT NOT NULL CHECK (severity IN ('VALID','WARNING','ERROR')),
          code TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          category TEXT,
          manufacturer TEXT,
          model TEXT,
          part_number TEXT,
          uom TEXT,
          ${TIMESTAMP_DDL},
          PRIMARY KEY (job_id, row_number)
        );
        CREATE INDEX idx_import_rows_job ON import_rows(job_id);

        -- DB-authoritative single-active-import guard (constant-expression
        -- partial unique index; same pattern as uq_matching_runs_active).
        CREATE UNIQUE INDEX uq_import_runs_active
          ON import_runs((1))
          WHERE status IN ('QUEUED', 'RUNNING');
      `);

      // Extend the audit action CHECK with import lifecycle events (same
      // rebuild pattern as migrations 3, 6 and 7).
      db.exec(`
        CREATE TABLE audit_logs_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL CHECK (action IN (
            'material_created','material_updated','material_reprocessed','import_performed','match_generated',
            'proposal_created','proposal_approved','proposal_rejected','proposal_deferred',
            'mapping_created','common_material_created','user_login','user_login_failed','user_logout','user_created',
            'user_updated','user_role_changed','demo_role_switched',
            'import_created','import_started','import_failed','import_retried'
          )),
          entity_type TEXT NOT NULL,
          entity_id INTEGER,
          actor TEXT NOT NULL DEFAULT 'system',
          details TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        INSERT INTO audit_logs_new (id, action, entity_type, entity_id, actor, details, created_at)
          SELECT id, action, entity_type, entity_id, actor, details, created_at FROM audit_logs;
        DROP TABLE audit_logs;
        ALTER TABLE audit_logs_new RENAME TO audit_logs;
        CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor, created_at);
      `);
    },
  },
  {
    version: 9,
    name: 'scale-hardening-indexes',
    up: (db) => {
      // Step-1 scale hardening (Phase-1 capability audit). Performance-only:
      // no schema, data, or behavior change.
      //  - match_candidates(status, final_score): the review-queue/workspace
      //    pages filter by status and ORDER BY final_score DESC — previously a
      //    full sort per page over the filtered set.
      //  - review_queue(opened_at): queue listing ORDER BY opened_at DESC.
      //  - material_records(organization_id, original_code): per-CPSE
      //    duplicate-code lookups during import (findMaterialByCode) and a
      //    uniqueness-assisting path for (org, code) identity.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_match_status_score ON match_candidates(status, final_score);
        CREATE INDEX IF NOT EXISTS idx_queue_opened ON review_queue(opened_at);
        CREATE INDEX IF NOT EXISTS idx_material_org_code ON material_records(organization_id, original_code);
      `);
    },
  },
  {
    version: 16,
    name: 'uom-conversion-rules',
    up: (db) => {
      // Step 17 - controlled UOM conversion registry. A rule is an explicit,
      // directional master-data statement (from_uom -> to_uom with an INTEGER
      // factor). Integer factors keep the decimal-safe aggregation exact:
      // normalized_cents = qty_cents * factor (pure integer arithmetic, no
      // floating point, no rounding). Reverse/scale-down conversions
      // (e.g. G -> KG = 0.001) are deliberately NOT registered - rules are
      // registered toward the unit that keeps factors integral, and reverse
      // derivation is documented as future work (Step 17 section 6).
      // SET has NO rule: no authoritative generic conversion exists, so
      // those records stay UNCONVERTED rather than being guessed (section 11).
      db.exec(`
        CREATE TABLE uom_conversion_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_uom TEXT NOT NULL CHECK (trim(from_uom) <> ''),
          to_uom TEXT NOT NULL CHECK (trim(to_uom) <> ''),
          factor INTEGER NOT NULL CHECK (factor > 0),
          rule_type TEXT NOT NULL CHECK (rule_type IN ('ALIAS','SCALE','DOMAIN_SPECIFIC')),
          source TEXT NOT NULL DEFAULT 'SYSTEM_DEFINED' CHECK (trim(source) <> ''),
          description TEXT,
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          CHECK (from_uom <> to_uom),
          UNIQUE (from_uom, to_uom, rule_type)
        );
        CREATE INDEX idx_uom_rules_from ON uom_conversion_rules(from_uom);
        CREATE INDEX idx_uom_rules_active ON uom_conversion_rules(is_active, from_uom);
      `);
      // SYSTEM_DEFINED seed: the authoritative starting registry (section 7).
      // DOMAIN_SPECIFIC is reserved and intentionally unpopulated - pack
      // conversions require authoritative per-material data (section 9).
      db.exec(`
        INSERT INTO uom_conversion_rules (from_uom, to_uom, factor, rule_type, source, description) VALUES
          ('PCS','EA', 1, 'ALIAS','SYSTEM_DEFINED','Count-unit alias: piece = each.'),
          ('NOS','EA', 1, 'ALIAS','SYSTEM_DEFINED','Count-unit alias: numbers = each.'),
          ('KG','G', 1000, 'SCALE','SYSTEM_DEFINED','SI mass scale: kilogram to gram.'),
          ('TON','G', 1000000, 'SCALE','SYSTEM_DEFINED','Mass scale: metric ton to gram (metric tonne only; short/hundredweight tons are ambiguous and stay UNCONVERTED - section 11). Direct hop to the canonical unit: no rule chains.'),
          ('L','ML', 1000, 'SCALE','SYSTEM_DEFINED','SI volume scale: litre to millilitre.'),
          ('M','MM', 1000, 'SCALE','SYSTEM_DEFINED','SI length scale: metre to millimetre.'),
          ('CM','MM', 10, 'SCALE','SYSTEM_DEFINED','SI length scale: centimetre to millimetre.');
      `);
    },
  },
  {
    // Step 18 - governed DOMAIN_SPECIFIC (CMI-scoped) UOM rules. CREATE-only:
    // the Step 17 registry (uom_conversion_rules and its 7 SYSTEM_DEFINED
    // rules) is untouched. Domain rules live in their own governed table with
    // a human lifecycle (PENDING -> APPROVED/REJECTED, APPROVED -> DISABLED
    // -> APPROVED); only APPROVED rows affect comparable quantities, and only
    // for procurement records of the scoped CMI's mapped members. Rules never
    // become active automatically - creation always starts at PENDING. The
    // partial UNIQUE index enforces at most one LIVE rule per (cmi_id,
    // from_uom); re-creation after REJECTION is allowed (supersede).
    version: 17,
    name: 'uom-domain-rules',
    up: (db) => {
      db.exec(`
        CREATE TABLE uom_domain_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cmi_id INTEGER NOT NULL REFERENCES common_materials(id),
          from_uom TEXT NOT NULL CHECK (trim(from_uom) <> ''),
          to_uom TEXT NOT NULL CHECK (trim(to_uom) <> ''),
          factor INTEGER NOT NULL CHECK (factor > 0),
          rule_type TEXT NOT NULL DEFAULT 'DOMAIN_SPECIFIC' CHECK (rule_type = 'DOMAIN_SPECIFIC'),
          status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','DISABLED')),
          source TEXT NOT NULL DEFAULT 'GOVERNED' CHECK (trim(source) <> ''),
          reason TEXT NOT NULL CHECK (trim(reason) <> ''),
          created_by TEXT NOT NULL,
          approved_by TEXT,
          decided_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          CHECK (from_uom <> to_uom)
        );
        CREATE INDEX idx_uom_domain_lookup ON uom_domain_rules(cmi_id, from_uom, status);
        CREATE UNIQUE INDEX uq_uom_domain_live
          ON uom_domain_rules(cmi_id, from_uom)
          WHERE status IN ('PENDING','APPROVED','DISABLED');
      `);
      // Extend the audit action CHECK with the governed UOM rule lifecycle
      // (same rebuild pattern as migrations 3, 6, 7, 11, 13 and 14). Only
      // human governance events are added - reads stay silent.
      db.exec(`
        CREATE TABLE audit_logs_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL CHECK (action IN (
            'material_created','material_updated','material_reprocessed','import_performed','match_generated',
            'proposal_created','proposal_approved','proposal_rejected','proposal_deferred',
            'mapping_created','common_material_created','user_login','user_login_failed','user_logout','user_created',
            'user_updated','user_role_changed','demo_role_switched',
            'import_created','import_started','import_failed','import_retried',
            'procurement_created','procurement_updated','supplier_created',
            'procurement_import_started','procurement_import_completed','procurement_import_failed',
            'procurement_opportunity_acknowledged','procurement_opportunity_dismissed',
            'procurement_opportunity_resolved','procurement_opportunity_reopened',
            'uom_rule_created','uom_rule_approved','uom_rule_rejected',
            'uom_rule_disabled','uom_rule_re_enabled'
          )),
          entity_type TEXT NOT NULL,
          entity_id INTEGER,
          actor TEXT NOT NULL DEFAULT 'system',
          details TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        INSERT INTO audit_logs_new (id, action, entity_type, entity_id, actor, details, created_at)
          SELECT id, action, entity_type, entity_id, actor, details, created_at FROM audit_logs;
        DROP TABLE audit_logs;
        ALTER TABLE audit_logs_new RENAME TO audit_logs;
        CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor, created_at);
      `);
    },
  },
  {
    version: 18,
    name: 'uom-rule-history',
    up: (db) => {
      // Step 19 (sections 3/4): append-only history for governed UOM domain
      // rules. The live row in uom_domain_rules stays authoritative; this
      // table answers "what happened to this rule over time?". UPDATE and
      // DELETE are physically refused (triggers below) - history can only
      // grow. One CREATE row is backfilled for rules that pre-date this
      // migration (insert always starts PENDING, so new_status='PENDING' is
      // exactly right for every backfilled creation).
      db.exec(`
        CREATE TABLE uom_rule_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rule_id INTEGER NOT NULL REFERENCES uom_domain_rules(id),
          cmi_id INTEGER NOT NULL,
          from_uom TEXT NOT NULL,
          to_uom TEXT NOT NULL,
          factor INTEGER NOT NULL,
          rule_type TEXT NOT NULL DEFAULT 'DOMAIN_SPECIFIC' CHECK (rule_type = 'DOMAIN_SPECIFIC'),
          previous_status TEXT CHECK (previous_status IS NULL OR previous_status IN ('PENDING','APPROVED','REJECTED','DISABLED')),
          new_status TEXT NOT NULL CHECK (new_status IN ('PENDING','APPROVED','REJECTED','DISABLED')),
          action TEXT NOT NULL CHECK (action IN ('CREATE','APPROVE','REJECT','DISABLE','RE_ENABLE')),
          actor TEXT NOT NULL CHECK (trim(actor) <> ''),
          reason TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX idx_uom_rule_history_rule ON uom_rule_history(rule_id, id);
        CREATE INDEX idx_uom_rule_history_time ON uom_rule_history(created_at);
        CREATE INDEX idx_uom_rule_history_actor ON uom_rule_history(actor, created_at);
        CREATE UNIQUE INDEX uq_uom_rule_history_create ON uom_rule_history(rule_id) WHERE action = 'CREATE';
        CREATE TRIGGER trg_uom_rule_history_no_update BEFORE UPDATE ON uom_rule_history
        BEGIN SELECT RAISE(ABORT, 'uom_rule_history is append-only: historical records must never be rewritten'); END;
        CREATE TRIGGER trg_uom_rule_history_no_delete BEFORE DELETE ON uom_rule_history
        BEGIN SELECT RAISE(ABORT, 'uom_rule_history is append-only: historical records must never be deleted'); END;
        INSERT INTO uom_rule_history
          (rule_id, cmi_id, from_uom, to_uom, factor, rule_type, previous_status, new_status, action, actor, reason, created_at)
        SELECT d.id, d.cmi_id, d.from_uom, d.to_uom, d.factor, d.rule_type,
               NULL, 'PENDING', 'CREATE', d.created_by, d.reason, d.created_at
          FROM uom_domain_rules d
         WHERE NOT EXISTS (SELECT 1 FROM uom_rule_history h WHERE h.rule_id = d.id);
      `);
    },
  },
  {
    version: 19,
    name: 'uom-rule-versions',
    up: (db) => {
      // Step 20 (sections 3/4): immutable CONTENT VERSIONS for governed
      // DOMAIN_SPECIFIC rules. A version row is written once and NEVER
      // updated or deleted (triggers below); the live rule points at the
      // currently effective version (effective_version_id) and, while an
      // amendment is awaiting a human decision, at the proposed version
      // (pending_version_id). Version content is the single authoritative
      // source for conversion of the effective version.
      db.exec(`
        CREATE TABLE uom_domain_rule_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rule_id INTEGER NOT NULL REFERENCES uom_domain_rules(id),
          version_number INTEGER NOT NULL CHECK (version_number >= 1),
          cmi_id INTEGER NOT NULL,
          from_uom TEXT NOT NULL CHECK (trim(from_uom) <> ''),
          to_uom TEXT NOT NULL CHECK (trim(to_uom) <> ''),
          factor INTEGER NOT NULL CHECK (factor > 0),
          rule_type TEXT NOT NULL DEFAULT 'DOMAIN_SPECIFIC' CHECK (rule_type = 'DOMAIN_SPECIFIC'),
          amendment_reason TEXT,
          created_by TEXT NOT NULL CHECK (trim(created_by) <> ''),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          supersedes_version_id INTEGER,
          CHECK (from_uom <> to_uom),
          UNIQUE (rule_id, version_number)
        );
        CREATE INDEX idx_uom_rule_versions_rule ON uom_domain_rule_versions(rule_id, version_number);
        CREATE INDEX idx_uom_rule_versions_supersedes ON uom_domain_rule_versions(supersedes_version_id);
        CREATE TRIGGER trg_uom_rule_versions_no_update BEFORE UPDATE ON uom_domain_rule_versions
        BEGIN SELECT RAISE(ABORT, 'uom_domain_rule_versions is immutable: rule content versions must never be rewritten'); END;
        CREATE TRIGGER trg_uom_rule_versions_no_delete BEFORE DELETE ON uom_domain_rule_versions
        BEGIN SELECT RAISE(ABORT, 'uom_domain_rule_versions is immutable: historical rule versions must remain available forever'); END;
      `);
      // Live-rule pointers (additive columns; NULL-safe). The rule row stays
      // the mutable lifecycle state; versions carry the immutable content.
      // NOTE: deliberately plain INTEGER (no FK) - a REFERENCES here would
      // create a FK cycle with uom_domain_rule_versions.rule_id, which is
      // illegal for the migration/backup tool's topological ordering. The
      // rule_id FK on versions keeps the parent-child edge; the pointers are
      // written only inside governed transactions.
      db.exec(`
        ALTER TABLE uom_domain_rules ADD COLUMN effective_version_id INTEGER;
        ALTER TABLE uom_domain_rules ADD COLUMN pending_version_id INTEGER;
        CREATE INDEX idx_uom_domain_pending ON uom_domain_rules(pending_version_id);
      `);
      // Backfill (section 22): exactly one initial version (v1) per existing
      // governed rule, content identical to the live row, so conversion
      // behavior is unchanged. APPROVED/DISABLED rules point at v1 as their
      // effective version (DISABLED rules were approved before being
      // disabled; they convert again on re-enable). PENDING/REJECTED rules
      // keep NULL - they have never had an effective version.
      db.exec(`
        INSERT INTO uom_domain_rule_versions
          (rule_id, version_number, cmi_id, from_uom, to_uom, factor, rule_type, amendment_reason, created_by, created_at, supersedes_version_id)
        SELECT d.id, 1, d.cmi_id, d.from_uom, d.to_uom, d.factor, d.rule_type, d.reason, d.created_by, d.created_at, NULL
          FROM uom_domain_rules d;
        UPDATE uom_domain_rules
           SET effective_version_id = (
                 SELECT v.id FROM uom_domain_rule_versions v
                  WHERE v.rule_id = uom_domain_rules.id AND v.version_number = 1)
         WHERE status IN ('APPROVED','DISABLED');
      `);
      // History gains version context (Step 19 section 11) and the AMEND
      // action (section 11). Rebuild follows the audit_logs pattern (v14/
      // v17): copy rows verbatim (existing rows keep version_id NULL -
      // history is never rewritten, even by migrations), drop, rename,
      // recreate indexes + append-only triggers.
      db.exec(`
        CREATE TABLE uom_rule_history_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rule_id INTEGER NOT NULL REFERENCES uom_domain_rules(id),
          cmi_id INTEGER NOT NULL,
          from_uom TEXT NOT NULL,
          to_uom TEXT NOT NULL,
          factor INTEGER NOT NULL,
          rule_type TEXT NOT NULL DEFAULT 'DOMAIN_SPECIFIC' CHECK (rule_type = 'DOMAIN_SPECIFIC'),
          previous_status TEXT CHECK (previous_status IS NULL OR previous_status IN ('PENDING','APPROVED','REJECTED','DISABLED')),
          new_status TEXT NOT NULL CHECK (new_status IN ('PENDING','APPROVED','REJECTED','DISABLED')),
          action TEXT NOT NULL CHECK (action IN ('CREATE','APPROVE','REJECT','DISABLE','RE_ENABLE','AMEND')),
          actor TEXT NOT NULL CHECK (trim(actor) <> ''),
          reason TEXT,
          version_id INTEGER,
          previous_version_id INTEGER,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        INSERT INTO uom_rule_history_new
          (id, rule_id, cmi_id, from_uom, to_uom, factor, rule_type, previous_status, new_status, action, actor, reason, created_at)
        SELECT id, rule_id, cmi_id, from_uom, to_uom, factor, rule_type, previous_status, new_status, action, actor, reason, created_at
          FROM uom_rule_history;
        DROP TABLE uom_rule_history;
        ALTER TABLE uom_rule_history_new RENAME TO uom_rule_history;
        CREATE INDEX idx_uom_rule_history_rule ON uom_rule_history(rule_id, id);
        CREATE INDEX idx_uom_rule_history_time ON uom_rule_history(created_at);
        CREATE INDEX idx_uom_rule_history_actor ON uom_rule_history(actor, created_at);
        CREATE UNIQUE INDEX uq_uom_rule_history_create ON uom_rule_history(rule_id) WHERE action = 'CREATE';
        CREATE TRIGGER trg_uom_rule_history_no_update BEFORE UPDATE ON uom_rule_history
        BEGIN SELECT RAISE(ABORT, 'uom_rule_history is append-only: historical records must never be rewritten'); END;
        CREATE TRIGGER trg_uom_rule_history_no_delete BEFORE DELETE ON uom_rule_history
        BEGIN SELECT RAISE(ABORT, 'uom_rule_history is append-only: historical records must never be deleted'); END;
      `);
      // Extend the audit action CHECK with uom_rule_amended (same rebuild
      // pattern as migrations 14 and 17). Amendment decisions reuse the
      // existing uom_rule_approved / uom_rule_rejected events with version
      // context in details - no second audit mechanism.
      db.exec(`
        CREATE TABLE audit_logs_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL CHECK (action IN (
            'material_created','material_updated','material_reprocessed','import_performed','match_generated',
            'proposal_created','proposal_approved','proposal_rejected','proposal_deferred',
            'mapping_created','common_material_created','user_login','user_login_failed','user_logout','user_created',
            'user_updated','user_role_changed','demo_role_switched',
            'import_created','import_started','import_failed','import_retried',
            'procurement_created','procurement_updated','supplier_created',
            'procurement_import_started','procurement_import_completed','procurement_import_failed',
            'procurement_opportunity_acknowledged','procurement_opportunity_dismissed',
            'procurement_opportunity_resolved','procurement_opportunity_reopened',
            'uom_rule_created','uom_rule_approved','uom_rule_rejected',
            'uom_rule_disabled','uom_rule_re_enabled','uom_rule_amended'
          )),
          entity_type TEXT NOT NULL,
          entity_id INTEGER,
          actor TEXT NOT NULL DEFAULT 'system',
          details TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        INSERT INTO audit_logs_new (id, action, entity_type, entity_id, actor, details, created_at)
          SELECT id, action, entity_type, entity_id, actor, details, created_at FROM audit_logs;
        DROP TABLE audit_logs;
        ALTER TABLE audit_logs_new RENAME TO audit_logs;
        CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor, created_at);
      `);
    },
  },
];

/** Apply all pending migrations. Safe to call on every start. */
export function migrate(db: DatabaseSync): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  const applied = new Set(
    (db.prepare('SELECT version FROM _migrations').all() as Array<{ version: number }>).map((r) => r.version)
  );
  const ran: number[] = [];
  for (const m of MIGRATIONS.sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      m.up(db);
      db.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
      db.exec('COMMIT');
      ran.push(m.version);
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* noop */
      }
      throw err;
    }
  }
  return ran;
}
