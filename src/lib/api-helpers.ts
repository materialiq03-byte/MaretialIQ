import { NextRequest, NextResponse } from 'next/server';
import { AppError, errors } from './errors';
import { ZodError } from 'zod';
import { config } from './config';

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ data }, { status });
}

/** Translate AppError/ZodError/unknown into safe JSON error responses. */
export function fail(err: unknown): NextResponse {
  if (err instanceof AppError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      { status: err.status }
    );
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: 'validation_error',
          message: 'Validation failed',
          details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        },
      },
      { status: 400 }
    );
  }
  // Unknown error: log server-side, return a generic message.
  console.error('[api] unhandled error:', err);
  return NextResponse.json({ error: { code: 'internal_error', message: 'An internal error occurred' } }, { status: 500 });
}

export function parsePagination(params: URLSearchParams): { page: number; pageSize: number } {
  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const raw = parseInt(params.get('pageSize') ?? String(config.pageSize.default), 10);
  const pageSize = Math.min(config.pageSize.max, Math.max(1, Number.isFinite(raw) ? raw : config.pageSize.default));
  return { page, pageSize };
}
