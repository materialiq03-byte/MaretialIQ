import { z } from 'zod';
import {
  DECISIONS,
  MATCH_TYPES,
  MATCH_STATUSES,
  QUEUE_PRIORITIES,
  QUEUE_STATUSES,
  IMPORT_STATUSES,
  ORG_STATUSES,
  MATERIAL_PROCESSING_STATUSES,
  QUALITY_STATUSES,
  EXTRACTION_METHODS,
} from '../types/domain';

/** Object id (SQLite integer PK). Accepts numeric strings; rejects 0/negatives. */
export const idSchema = z.coerce.number().int().positive();

export const orgCreateSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, 'Code must be at least 2 characters')
    .max(10)
    .regex(/^[A-Z0-9]+$/, 'Code must be uppercase letters/digits'),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional(),
});
export type OrgCreate = z.infer<typeof orgCreateSchema>;

export const orgUpdateSchema = orgCreateSchema.partial().extend({
  status: z.enum(ORG_STATUSES).optional(),
});
export type OrgUpdate = z.infer<typeof orgUpdateSchema>;

/** Platform user administration — mirrors admin-service.createUserAsync rules. */
export const userCreateSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
  role: z.enum(['cpse_material_manager', 'cpse_technical_reviewer', 'authority', 'platform_admin']),
  organizationId: idSchema.optional(),
});
export type UserCreate = z.infer<typeof userCreateSchema>;

/** Demo role switch — target user the admin wants a real session for. */
export const demoSwitchSchema = z.object({
  userId: idSchema,
});
export type DemoSwitch = z.infer<typeof demoSwitchSchema>;

export const materialCreateSchema = z.object({
  organizationId: idSchema,
  originalCode: z
    .string()
    .trim()
    .min(2, 'Material code must be at least 2 characters')
    .max(50)
    .regex(/^[A-Za-z0-9][A-Za-z0-9\-\/_.]*$/, 'Code may contain letters, digits and - / _ . only'),
  originalDescription: z.string().trim().min(3, 'Description must be at least 3 characters').max(500),
  normalizedDescription: z.string().trim().max(500).optional(),
  category: z.string().trim().min(2).max(80),
  subcategory: z.string().trim().max(80).optional(),
  manufacturer: z.string().trim().max(120).optional(),
  model: z.string().trim().max(80).optional(),
  partNumber: z.string().trim().max(80).optional(),
  materialType: z.string().trim().max(80).optional(),
  uom: z.string().trim().min(1).max(20),
  importId: idSchema.optional(),
  processingStatus: z.enum(MATERIAL_PROCESSING_STATUSES).optional(),
  classificationConfidence: z.number().min(0).max(100).nullable().optional(),
  classificationSource: z.string().trim().max(60).nullable().optional(),
  qualityStatus: z.enum(QUALITY_STATUSES).nullable().optional(),
  qualityChecks: z.string().max(4000).nullable().optional(),
});

export const attributeValueSchema = z.object({
  attributeName: z
    .string()
    .trim()
    .min(2, 'Attribute name required')
    .max(60)
    .regex(/^[a-z0-9_]+$/, 'Attribute name must be snake_case'),
  value: z.string().trim().min(1).max(120),
  normalizedValue: z.string().trim().max(120).nullable().optional(),
  unit: z.string().trim().max(20).nullable().optional(),
  isCritical: z.boolean().optional(),
  extractionMethod: z.enum(EXTRACTION_METHODS).optional(),
  confidence: z.number().min(0).max(100).nullable().optional(),
});

export const materialUpdateSchema = materialCreateSchema.partial().omit({ organizationId: true }).extend({
  attributes: z.array(attributeValueSchema).max(50, 'Too many attributes').optional(),
});
export type MaterialCreate = z.infer<typeof materialCreateSchema>;
export type MaterialUpdate = z.infer<typeof materialUpdateSchema>;

export const importCreateSchema = z.object({
  organizationId: idSchema,
  fileName: z.string().trim().min(1).max(200),
  fileType: z.enum(['csv', 'xlsx']),
  totalRows: z.number().int().min(0).max(1_000_000),
});

export const importStatusSchema = z.object({
  status: z.enum(IMPORT_STATUSES),
  successfulRows: z.number().int().min(0).optional(),
  failedRows: z.number().int().min(0).optional(),
  errorInfo: z.string().max(2000).optional(),
});

export const matchQuerySchema = z.object({
  status: z.enum(MATCH_STATUSES).optional(),
  matchType: z.enum(MATCH_TYPES).optional(),
  organizationCode: z.string().trim().max(10).optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

export const decisionSchema = z.object({
  decision: z.enum(DECISIONS),
  reviewer: z.string().trim().min(2, 'Reviewer name required (min 2 characters)').max(120),
  comment: z.string().trim().max(1000).optional(),
});
export type DecisionInput = z.infer<typeof decisionSchema>;

export const queueQuerySchema = z.object({
  status: z.enum(QUEUE_STATUSES).optional(),
  priority: z.enum(QUEUE_PRIORITIES).optional(),
  // Step 23 review-workspace filters (§16/§17) — existing database fields.
  category: z.string().trim().max(80).optional(),
  /** Confidence band from the evidence document (high|review|low|reject). */
  band: z.enum(['high', 'review', 'low', 'reject']).optional(),
  /** '1' → only candidates carrying a critical technical conflict. */
  conflict: z.enum(['0', '1']).optional(),
  sort: z.enum(['score_desc', 'score_asc', 'oldest', 'newest', 'priority']).optional(),
});

export const queueCreateSchema = z.object({
  matchId: idSchema,
  priority: z.enum(QUEUE_PRIORITIES),
  reason: z.string().trim().min(3).max(300),
  criticalDifference: z.string().trim().max(300).optional(),
});

export const queueUpdateSchema = z.object({
  status: z.enum(QUEUE_STATUSES).optional(),
  assignedReviewer: z.string().trim().max(120).optional(),
});

export const cmiCreateSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(30)
    .regex(/^[A-Z0-9][A-Z0-9\-_]*$/, 'CMI code must be uppercase letters/digits with - or _'),
  name: z.string().trim().min(3).max(160),
  description: z.string().trim().max(500).optional(),
  category: z.string().trim().min(2).max(80),
  matchId: idSchema,
});

export const mappingCreateSchema = z.object({
  cmiId: idSchema,
  materialId: idSchema,
});

/** Step 12: exact decimal, at most 2 fraction digits (stored verbatim). */
const decimalSchema = z
  .string()
  .trim()
  .regex(/^-?\d+(\.\d{1,2})?$/, 'Must be an exact decimal with at most 2 fraction digits');

export const supplierCreateSchema = z.object({
  supplierCode: z.string().trim().min(2).max(30).regex(/^[A-Z0-9][A-Z0-9\-_]*$/, 'Supplier code must be uppercase letters/digits with - or _'),
  supplierName: z.string().trim().min(2).max(160),
  region: z.string().trim().max(80).optional(),
});

export const procurementCreateSchema = z
  .object({
    organizationId: idSchema,
    materialId: idSchema,
    cmiId: idSchema.optional(),
    supplierId: idSchema,
    purchaseOrderReference: z.string().trim().min(1).max(80),
    purchaseDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'purchaseDate must be YYYY-MM-DD'),
    deliveryDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    quantity: decimalSchema,
    uom: z.string().trim().min(1).max(12),
    unitPrice: decimalSchema.optional(),
    currency: z.string().trim().length(3).toUpperCase().optional(),
    plantLocation: z.string().trim().max(80).optional(),
    status: z.enum(['ORDERED', 'PARTIALLY_DELIVERED', 'DELIVERED', 'CANCELLED']),
    sourceSystem: z.string().trim().max(80).optional(),
  })
  .refine((v) => (v.unitPrice === undefined) === (v.currency === undefined), {
    message: 'unitPrice and currency must be provided together',
    path: ['currency'],
  });

/** Parse or throw a 400 AppError with field details. */
export function parseOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown
): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({
      field: i.path.join('.') || '(root)',
      message: i.message,
    }));
    throw new (require('../errors').AppError)(400, 'validation_error', 'Validation failed', details);
  }
  return result.data as z.infer<T>;
}

// Step 15 - procurement opportunity review actions (section 29: dismiss /
// resolve / reopen require a short human reason; acknowledge does not).
export const opportunityReviewSchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.reason === undefined || v.reason.length > 0, {
    message: 'reason must not be empty',
    path: ['reason'],
  });

/**
 * Step 18: governed DOMAIN_SPECIFIC UOM rule proposal. Scope (cmiId),
 * conversion (from/to/factor) and a non-empty human reason/evidence are all
 * mandatory; the lifecycle starts at PENDING server-side and is never chosen
 * by the client.
 */
export const uomDomainRuleCreateSchema = z
  .object({
    cmiId: z.coerce.number().int().positive(),
    fromUom: z.string().trim().min(1).max(16),
    toUom: z.string().trim().min(1).max(16),
    factor: z.coerce.number().int().positive(),
    reason: z.string().trim().min(1).max(500),
  })
  .refine((v) => v.fromUom.trim().toUpperCase() !== v.toUom.trim().toUpperCase(), {
    message: 'fromUom and toUom must differ',
    path: ['toUom'],
  });

/** Step 18: one governed lifecycle transition per request. */
export const uomRuleTransitionSchema = z.object({
  action: z.enum(['approve', 'reject', 'disable', 're-enable']),
  reason: z.string().trim().max(500).optional(),
});

/** Step 20: propose an amendment (new immutable version) for a governed rule. */
export const uomRuleAmendSchema = z
  .object({
    fromUom: z.string().trim().min(1).max(16).optional(),
    toUom: z.string().trim().min(1).max(16).optional(),
    factor: z.coerce.number().int().positive().optional(),
    reason: z.string().trim().min(1).max(500),
  })
  .refine((v) => {
    const from = v.fromUom?.trim().toUpperCase();
    const to = v.toUom?.trim().toUpperCase();
    if (from !== undefined && to !== undefined) return from !== to;
    return true;
  }, {
    message: 'fromUom and toUom must differ',
    path: ['toUom'],
  });

/** Step 20: decide a pending amendment (approve or reject only). */
export const uomRuleAmendDecisionSchema = z.object({
  action: z.enum(['approve', 'reject']),
});
