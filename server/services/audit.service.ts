import type { Database } from '~~/database'
import {
  type AuditListFilter,
  type AuditRow,
  findAuditById,
  insertAudit,
  listAudit,
} from '../repositories/audit.repository'
import { redactPayload } from '../network/redact'
import type { AuditQuery, AuditResponse } from '#shared/schemas/audit.schema'
import type { Paginated } from '#shared/schemas/common.schema'

/**
 * Audit trail service — the write + read path for the system of record.
 *
 * SECURITY: every JSONB payload is passed through `redactPayload` before it is
 * stored, so the per-engineer execution credentials and any secret are masked to
 * `***` and never persisted. There is deliberately no update/delete path.
 */

export interface RecordAuditInput {
  userId?: string | null
  username?: string | null
  userRole?: string | null
  module: AuditRow['module']
  action: AuditRow['action']
  status: AuditRow['status']
  sourceIp?: string | null
  userAgent?: string | null
  changeTicket?: string | null
  correlationId: string
  requestPayload?: unknown
  commandPayload?: unknown
  executionPayload?: unknown
  responsePayload?: unknown
}

/** Write one audit log. Payloads are redacted here, right before insert. */
export async function record(db: Database, input: RecordAuditInput): Promise<void> {
  await insertAudit(db, {
    userId: input.userId ?? null,
    username: input.username ?? null,
    userRole: input.userRole ?? null,
    module: input.module,
    action: input.action,
    status: input.status,
    sourceIp: input.sourceIp ?? null,
    userAgent: input.userAgent ?? null,
    changeTicket: input.changeTicket ?? null,
    correlationId: input.correlationId,
    requestPayload: input.requestPayload === undefined ? null : redactPayload(input.requestPayload),
    commandPayload: input.commandPayload === undefined ? null : redactPayload(input.commandPayload),
    executionPayload: input.executionPayload === undefined ? null : redactPayload(input.executionPayload),
    responsePayload: input.responsePayload === undefined ? null : redactPayload(input.responsePayload),
  })
}

/** Map a DB row to the safe client response shape. */
export function toAuditResponse(row: AuditRow): AuditResponse {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    userId: row.userId,
    username: row.username,
    userRole: row.userRole,
    module: row.module,
    action: row.action,
    status: row.status,
    sourceIp: row.sourceIp,
    userAgent: row.userAgent,
    changeTicket: row.changeTicket,
    correlationId: row.correlationId,
    requestPayload: row.requestPayload ?? null,
    commandPayload: row.commandPayload ?? null,
    executionPayload: row.executionPayload ?? null,
    responsePayload: row.responsePayload ?? null,
  }
}

function toFilter(query: AuditQuery): AuditListFilter {
  return {
    page: query.page,
    limit: query.limit,
    search: query.search,
    module: query.module,
    action: query.action,
    status: query.status,
    changeTicket: query.changeTicket,
    correlationId: query.correlationId,
    from: query.from ? new Date(query.from) : undefined,
    to: query.to ? new Date(query.to) : undefined,
  }
}

/** Paginated audit list for the Log Trail. */
export async function list(db: Database, query: AuditQuery): Promise<Paginated<AuditResponse>> {
  const { items, total } = await listAudit(db, toFilter(query))
  return {
    items: items.map(toAuditResponse),
    page: query.page,
    limit: query.limit,
    total,
  }
}

/** One audit entry (detail view), or null. */
export async function getById(db: Database, id: string): Promise<AuditResponse | null> {
  const row = await findAuditById(db, id)
  return row ? toAuditResponse(row) : null
}

/**
 * Export the selected audit entries. Returns all matching rows (no pagination
 * limit applied beyond the filter) mapped to the safe response shape.
 */
export async function exportEntries(db: Database, query: AuditQuery): Promise<AuditResponse[]> {
  // Reuse the list filter but with a large page size for export.
  const { items } = await listAudit(db, { ...toFilter(query), page: 1, limit: 10000 })
  return items.map(toAuditResponse)
}
