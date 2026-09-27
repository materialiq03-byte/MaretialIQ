/**
 * Domain identifiers. Centralised so status/decision enums are consistent
 * between the schema constraints, validation and UI.
 */

/**
 * Material processing lifecycle. The first four are pipeline stages; `warning`
 * and `error` are terminal-for-matching states set by the data-quality check.
 */
export const MATERIAL_PROCESSING_STATUSES = [
  'imported',
  'normalised',
  'classified',
  'attributes_extracted',
  'ready_for_matching',
  'warning',
  'error',
] as const;
export type MaterialProcessingStatus = (typeof MATERIAL_PROCESSING_STATUSES)[number];

/** Data-quality verdicts computed by the pipeline. No numeric score is invented. */
export const QUALITY_STATUSES = ['good', 'warning', 'incomplete', 'invalid'] as const;
export type QualityStatus = (typeof QUALITY_STATUSES)[number];

/** Where a classification or attribute value came from. */
export const EXTRACTION_METHODS = ['rule', 'manual', 'imported'] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

export const IMPORT_STATUSES = [
  'pending',
  'processing',
  'completed',
  'failed',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const MATCH_STATUSES = ['pending', 'approved', 'rejected', 'deferred'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const MATCH_TYPES = [
  'identical',
  'near_duplicate',
  'functional_equivalent',
  'needs_review',
  'different',
] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

export const DECISIONS = ['approved', 'rejected', 'deferred', 'sent_for_review'] as const;
export type Decision = (typeof DECISIONS)[number];

export const QUEUE_STATUSES = ['open', 'in_progress', 'resolved'] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export const QUEUE_PRIORITIES = ['high', 'medium', 'low'] as const;
export type QueuePriority = (typeof QUEUE_PRIORITIES)[number];

export const AUDIT_ACTIONS = [
  'material_created',
  'material_updated',
  'material_reprocessed',
  'import_performed',
  'match_generated',
  'proposal_created',
  'proposal_approved',
  'proposal_rejected',
  'proposal_deferred',
  'mapping_created',
  'common_material_created',
  'import_created',
  'import_started',
  'import_failed',
  'import_retried',
  'user_login',
  'user_login_failed',
  'user_logout',
  'user_created',
  'user_updated',
  'user_role_changed',
  'demo_role_switched',
  'procurement_created',
  'procurement_updated',
  'supplier_created',
  // Step 13: procurement import lifecycle.
  'procurement_import_started',
  'procurement_import_completed',
  'procurement_import_failed',
  // Step 15: procurement opportunity human-review lifecycle (detection itself
  // is silent - only human status transitions are audited).
  'procurement_opportunity_acknowledged',
  'procurement_opportunity_dismissed',
  'procurement_opportunity_resolved',
  'procurement_opportunity_reopened',
  // Step 18: governed DOMAIN_SPECIFIC UOM rule lifecycle. Only creation and
  // human transitions are audited - never ordinary read-only page views.
  'uom_rule_created',
  'uom_rule_approved',
  'uom_rule_rejected',
  'uom_rule_disabled',
  'uom_rule_re_enabled',
  // Step 20: governed content amendment of an approved rule.
  'uom_rule_amended',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Step 12: controlled procurement status vocabulary (check-constrained in both dialects). */
export const PROCUREMENT_STATUSES = ['ORDERED', 'PARTIALLY_DELIVERED', 'DELIVERED', 'CANCELLED'] as const;
export type ProcurementStatus = (typeof PROCUREMENT_STATUSES)[number];

/**
 * Step 15: controlled procurement-opportunity taxonomy. An opportunity means
 * "observed procurement pattern that may deserve human investigation" - never
 * "do this". Detection is deterministic SQL; signals are explainable evidence.
 */
export const OPPORTUNITY_TYPES = [
  'CROSS_CPSE_DEMAND',
  'REPEATED_PROCUREMENT',
  'FRAGMENTED_DEMAND',
  'UNHARMONIZED_RELATED_PROCUREMENT',
  'MULTI_SUPPLIER_ACTIVITY',
  'HIGH_PROCUREMENT_ACTIVITY',
] as const;
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

/** Human-review lifecycle (Step 15 section 6/31): OPEN is not approval. */
export const OPPORTUNITY_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'DISMISSED', 'RESOLVED'] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

/**
 * Step 17: controlled UOM conversion vocabulary. Rules are explicit,
 * directional master-data statements (from -> to, INTEGER factor) - never
 * inferred from descriptions or invented (Step 17 sections 6-8). Row-level
 * conversion statuses (section 12): INCOMPATIBLE is reserved for future
 * material-scoped conflicts; DOMAIN_SPECIFIC rules are not applied in global
 * aggregation (they are material-scoped by definition).
 */
export const UOM_RULE_TYPES = ['ALIAS', 'SCALE', 'DOMAIN_SPECIFIC'] as const;
export type UomRuleType = (typeof UOM_RULE_TYPES)[number];
export const UOM_CONVERSION_STATUSES = [
  'NORMALIZED',
  'ALIAS_NORMALIZED',
  'SCALED',
  'UNCONVERTED',
  'INCOMPATIBLE',
  'INVALID',
] as const;
export type UomConversionStatus = (typeof UOM_CONVERSION_STATUSES)[number];

/** Step 17 section 31: procurement UOM data-quality categories. */
export const UOM_QUALITY_CATEGORIES = [
  'VALID_CANONICAL',
  'VALID_ALIAS',
  'VALID_CONVERTED',
  'UNCONVERTED',
  'INCOMPATIBLE',
  'UNKNOWN',
] as const;
export type UomQualityCategory = (typeof UOM_QUALITY_CATEGORIES)[number];

/**
 * Step 18: governed lifecycle for DOMAIN_SPECIFIC (CMI-scoped) UOM rules.
 * PENDING rules are visible but never affect comparable quantities; only
 * APPROVED does, and only inside its CMI scope. New rules always start
 * PENDING - they never become active automatically.
 */
export const UOM_DOMAIN_RULE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'DISABLED'] as const;
export type UomDomainRuleStatus = (typeof UOM_DOMAIN_RULE_STATUSES)[number];

export const ORG_STATUSES = ['active', 'inactive'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];
