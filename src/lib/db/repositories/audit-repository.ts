import { getDb } from '../client';
import { parseJson } from '../util';
import type { AuditAction } from '../../types/domain';

export interface AuditLogRow {
  id: number;
  action: AuditAction;
  entity_type: string;
  entity_id: number | null;
  actor: string;
  details: Record<string, unknown> | null;
  created_at: string;
}

const SELECT = `SELECT * FROM audit_logs`;

export function recordAudit(entry: {
  action: AuditAction;
  entityType: string;
  entityId?: number | null;
  actor?: string;
  details?: Record<string, unknown>;
}): void {
  getDb()
    .prepare(
      `INSERT INTO audit_logs (action, entity_type, entity_id, actor, details) VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      entry.actor ?? 'system',
      entry.details ? JSON.stringify(entry.details) : null
    );
}

export function listAudit(opts: {
  entityType?: string;
  entityId?: number;
  actor?: string;
  action?: string;
  page: number;
  pageSize: number;
}) {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (opts.action) {
    clauses.push('action = ?');
    params.push(opts.action);
  }
  if (opts.entityType) {
    clauses.push('entity_type = ?');
    params.push(opts.entityType);
  }
  if (opts.entityId !== undefined) {
    clauses.push('entity_id = ?');
    params.push(opts.entityId);
  }
  if (opts.actor) {
    clauses.push('actor = ?');
    params.push(opts.actor);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = getDb()
    .prepare(`${SELECT} ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, opts.pageSize, (opts.page - 1) * opts.pageSize) as unknown as AuditLogRow[];
  for (const row of rows) {
    row.details = parseJson(row.details as unknown as string | null, null as Record<string, unknown> | null);
  }
  const total = (
    getDb().prepare(`SELECT COUNT(*) AS n FROM audit_logs ${where}`).get(...params) as unknown as { n: number }
  ).n;
  return { items: rows, total };
}

export function countAudit(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM audit_logs').get() as unknown as { n: number }).n;
}
