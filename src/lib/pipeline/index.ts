/**
 * Processing pipeline orchestrator.
 *
 * normalize → classify → extract → quality. Pure functions; persistence is
 * done by callers (material-service, import pipeline, reprocess endpoint).
 *
 * This module is the seam where the future intelligence layer plugs in: the
 * matching engine reads the structured attributes produced here, and the
 * embedding/LLM services of the next stage will consume the same outputs.
 */
import { normalizeDescription } from './normalize';
import { classifyDescription, type ClassificationResult } from './classify';
import { extractAttributes, type ExtractedAttribute } from './extract';
import { evaluateQuality, type QualityReport } from './quality';
import type { MaterialProcessingStatus } from '../types/domain';

export { normalizeDescription } from './normalize';
export { classifyDescription } from './classify';
export { extractAttributes } from './extract';
export { evaluateQuality } from './quality';

export interface PipelineOutput {
  normalizedDescription: string;
  classification: ClassificationResult;
  attributes: ExtractedAttribute[];
  quality: QualityReport;
  /** Terminal pipeline status to persist on the material record. */
  processingStatus: MaterialProcessingStatus;
}

/** Derive the persisted processing status from the pipeline outcome. */
function statusFor(quality: QualityReport, classified: boolean): MaterialProcessingStatus {
  if (quality.status === 'invalid') return 'error';
  if (quality.status === 'warning') return 'warning';
  if (!classified) return 'normalised';
  return 'attributes_extracted';
}

/**
 * Run the deterministic pipeline over one raw description.
 * `categoryOverride` lets an import/record pin the category (skips rules);
 * confidence/source then record that it came from the supplied value.
 */
export function runPipeline(input: {
  originalDescription: string;
  categoryOverride?: string | null;
}): PipelineOutput {
  const normalizedDescription = normalizeDescription(input.originalDescription);

  let classification: ClassificationResult;
  if (input.categoryOverride && input.categoryOverride.trim()) {
    classification = {
      category: input.categoryOverride.trim() as ClassificationResult['category'],
      subcategory: null,
      confidence: null,
      source: 'supplied',
    };
  } else {
    classification = classifyDescription(normalizedDescription);
  }

  const attributes = extractAttributes(classification.category, normalizedDescription);
  const quality = evaluateQuality({
    originalDescription: input.originalDescription,
    normalizedDescription,
    category: classification.category,
    attributes,
  });

  return {
    normalizedDescription,
    classification,
    attributes,
    quality,
    processingStatus: statusFor(quality, classification.category !== null),
  };
}
