/**
 * Typed application errors mapped to HTTP responses. Services throw these;
 * API routes translate them. Internal error details are logged, never returned.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const errors = {
  badRequest: (msg: string, details?: unknown) => new AppError(400, 'bad_request', msg, details),
  unauthorized: (msg = 'Authentication required') => new AppError(401, 'unauthorized', msg),
  forbidden: (msg = 'You do not have permission to perform this action') => new AppError(403, 'forbidden', msg),
  notFound: (entity: string) => new AppError(404, 'not_found', `${entity} not found`),
  conflict: (msg: string, details?: unknown) => new AppError(409, 'conflict', msg, details),
  validation: (details: unknown, msg = 'Validation failed') => new AppError(400, 'validation_error', msg, details),
  /** Step 25: bounded request bodies (413 per the API error matrix). */
  payloadTooLarge: (msg = 'Request body too large.') => new AppError(413, 'payload_too_large', msg),
  internal: (msg = 'An internal error occurred') => new AppError(500, 'internal_error', msg),
};
