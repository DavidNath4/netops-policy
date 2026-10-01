import { and, count, desc, eq, gte, lte } from 'drizzle-orm'

import type { Database, DbOrTx } from '~~/database'
import { routeLogs } from '~~/database/schema/route-logs'

/**
 * Data-access layer for the `route_logs` detail table — a COMPLEMENT to
 * `audit_logs` for ROUTE execution inspection.
 *
 * Repositories only talk to the database. This one exposes NO update or delete:
 * detail rows are immutable. Values inserted here are already redacted by the
 * route service. The `db` param also accepts a transaction handle (assignment
 * compatible), so the insert can run inside the audit transaction.
 */

export type RouteLogRow = typeof routeLogs.$inferSelect
export type InsertRouteLog = typeof routeLogs.$inferInsert

/** Insert one route_logs row. Values must already be redacted (no raw secrets). */
export async function insertRouteLog(db: DbOrTx, input: InsertRouteLog): Promise<RouteLogRow> {
  const [row] = await db.insert(routeLogs).values(input).returning()
  if (!row) {
    throw new Error('Failed to write route log: no row returned from insert')
  }
  return row
}

export interface RouteLogListFilter {
  page: number
  limit: number
  action?: RouteLogRow['action']
  status?: RouteLogRow['status']
  correlationId?: string
  changeTicket?: string
  from?: Date
  to?: Date
}

/** Paginated, filtered route_logs list, newest first. */
export async function listRouteLog(
  db: Database,
  filter: RouteLogListFilter,
): Promise<{ items: RouteLogRow[], total: number }> {
  const conditions = []

  if (filter.action) conditions.push(eq(routeLogs.action, filter.action))
  if (filter.status) conditions.push(eq(routeLogs.status, filter.status))
  if (filter.correlationId) conditions.push(eq(routeLogs.correlationId, filter.correlationId))
  if (filter.changeTicket) conditions.push(eq(routeLogs.changeTicket, filter.changeTicket))
  if (filter.from) conditions.push(gte(routeLogs.createdAt, filter.from))
  if (filter.to) conditions.push(lte(routeLogs.createdAt, filter.to))

  const where = conditions.length > 0 ? and(...conditions) : undefined

  const [{ value: total } = { value: 0 }] = await db
    .select({ value: count() })
    .from(routeLogs)
    .where(where)

  const items = await db
    .select()
    .from(routeLogs)
    .where(where)
    .orderBy(desc(routeLogs.createdAt))
    .limit(filter.limit)
    .offset((filter.page - 1) * filter.limit)

  return { items, total }
}

/** All route_logs detail rows for one operation, newest first. */
export function findRouteLogByCorrelationId(db: Database, correlationId: string): Promise<RouteLogRow[]> {
  return db
    .select()
    .from(routeLogs)
    .where(eq(routeLogs.correlationId, correlationId))
    .orderBy(desc(routeLogs.createdAt))
}
