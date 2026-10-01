import type { Database } from '~~/database'
import {
  type RouteLogListFilter,
  type RouteLogRow,
  findRouteLogByCorrelationId,
  listRouteLog,
} from '../repositories/route-log.repository'
import type { RouteLogQuery, RouteLogResponse } from '#shared/schemas/exec-log.schema'
import type { Paginated } from '#shared/schemas/common.schema'

/**
 * ROUTE detail-log read service. route_logs is written transactionally by the
 * route service (see route.service.ts); this is the read path for the inspection
 * panel.
 *
 * The JSONB columns are already redacted at write time, so they are passed
 * through as-is here. There is deliberately no write/update/delete path.
 */

/** Map a DB row to the safe client response shape. */
export function toRouteLogResponse(row: RouteLogRow): RouteLogResponse {
  return {
    id: row.id,
    auditId: row.auditId,
    correlationId: row.correlationId,
    action: row.action,
    status: row.status,
    device: row.device ?? null,
    destination: row.destination ?? null,
    changeTicket: row.changeTicket ?? null,
    commandPreview: row.commandPreview ?? null,
    executionMeta: row.executionMeta ?? null,
    responseSummary: row.responseSummary ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

function toFilter(query: RouteLogQuery): RouteLogListFilter {
  return {
    page: query.page,
    limit: query.limit,
    action: query.action,
    status: query.status,
    correlationId: query.correlationId,
    changeTicket: query.changeTicket,
    from: query.from ? new Date(query.from) : undefined,
    to: query.to ? new Date(query.to) : undefined,
  }
}

/** Paginated ROUTE detail-log list. */
export async function list(db: Database, query: RouteLogQuery): Promise<Paginated<RouteLogResponse>> {
  const { items, total } = await listRouteLog(db, toFilter(query))
  return {
    items: items.map(toRouteLogResponse),
    page: query.page,
    limit: query.limit,
    total,
  }
}

/** All ROUTE detail rows for one operation (inspection panel). */
export async function getByCorrelationId(db: Database, correlationId: string): Promise<RouteLogResponse[]> {
  const rows = await findRouteLogByCorrelationId(db, correlationId)
  return rows.map(toRouteLogResponse)
}
