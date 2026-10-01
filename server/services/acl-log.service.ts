import type { Database } from '~~/database'
import {
  type AclLogListFilter,
  type AclLogRow,
  findAclLogByCorrelationId,
  listAclLog,
} from '../repositories/acl-log.repository'
import type { AclLogQuery, AclLogResponse } from '#shared/schemas/exec-log.schema'
import type { Paginated } from '#shared/schemas/common.schema'

/**
 * ACL detail-log read service. acl_logs is written transactionally by the ACL
 * service (see acl.service.ts); this is the read path for the inspection panel.
 *
 * The JSONB columns are already redacted at write time, so they are passed
 * through as-is here. There is deliberately no write/update/delete path.
 */

/** Map a DB row to the safe client response shape. */
export function toAclLogResponse(row: AclLogRow): AclLogResponse {
  return {
    id: row.id,
    auditId: row.auditId,
    correlationId: row.correlationId,
    action: row.action,
    status: row.status,
    device: row.device ?? null,
    source: row.source ?? null,
    destination: row.destination ?? null,
    commandPreview: row.commandPreview ?? null,
    executionMeta: row.executionMeta ?? null,
    responseSummary: row.responseSummary ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

function toFilter(query: AclLogQuery): AclLogListFilter {
  return {
    page: query.page,
    limit: query.limit,
    action: query.action,
    status: query.status,
    correlationId: query.correlationId,
    from: query.from ? new Date(query.from) : undefined,
    to: query.to ? new Date(query.to) : undefined,
  }
}

/** Paginated ACL detail-log list. */
export async function list(db: Database, query: AclLogQuery): Promise<Paginated<AclLogResponse>> {
  const { items, total } = await listAclLog(db, toFilter(query))
  return {
    items: items.map(toAclLogResponse),
    page: query.page,
    limit: query.limit,
    total,
  }
}

/** All ACL detail rows for one operation (inspection panel). */
export async function getByCorrelationId(db: Database, correlationId: string): Promise<AclLogResponse[]> {
  const rows = await findAclLogByCorrelationId(db, correlationId)
  return rows.map(toAclLogResponse)
}
