import { and, count, desc, eq, gte, lte } from 'drizzle-orm'

import type { Database, DbOrTx } from '~~/database'
import { aclLogs } from '~~/database/schema/acl-logs'

/**
 * Data-access layer for the `acl_logs` detail table — a COMPLEMENT to
 * `audit_logs` for ACL execution inspection.
 *
 * Repositories only talk to the database. This one exposes NO update or delete:
 * detail rows are immutable. Values inserted here are already redacted by the
 * ACL service. The `db` param also accepts a transaction handle (assignment
 * compatible), so the insert can run inside the audit transaction.
 */

export type AclLogRow = typeof aclLogs.$inferSelect
export type InsertAclLog = typeof aclLogs.$inferInsert

/** Insert one acl_logs row. Values must already be redacted (no raw secrets). */
export async function insertAclLog(db: DbOrTx, input: InsertAclLog): Promise<AclLogRow> {
  const [row] = await db.insert(aclLogs).values(input).returning()
  if (!row) {
    throw new Error('Failed to write acl log: no row returned from insert')
  }
  return row
}

export interface AclLogListFilter {
  page: number
  limit: number
  action?: AclLogRow['action']
  status?: AclLogRow['status']
  correlationId?: string
  from?: Date
  to?: Date
}

/** Paginated, filtered acl_logs list, newest first. */
export async function listAclLog(
  db: Database,
  filter: AclLogListFilter,
): Promise<{ items: AclLogRow[], total: number }> {
  const conditions = []

  if (filter.action) conditions.push(eq(aclLogs.action, filter.action))
  if (filter.status) conditions.push(eq(aclLogs.status, filter.status))
  if (filter.correlationId) conditions.push(eq(aclLogs.correlationId, filter.correlationId))
  if (filter.from) conditions.push(gte(aclLogs.createdAt, filter.from))
  if (filter.to) conditions.push(lte(aclLogs.createdAt, filter.to))

  const where = conditions.length > 0 ? and(...conditions) : undefined

  const [{ value: total } = { value: 0 }] = await db
    .select({ value: count() })
    .from(aclLogs)
    .where(where)

  const items = await db
    .select()
    .from(aclLogs)
    .where(where)
    .orderBy(desc(aclLogs.createdAt))
    .limit(filter.limit)
    .offset((filter.page - 1) * filter.limit)

  return { items, total }
}

/** All acl_logs detail rows for one operation, newest first. */
export function findAclLogByCorrelationId(db: Database, correlationId: string): Promise<AclLogRow[]> {
  return db
    .select()
    .from(aclLogs)
    .where(eq(aclLogs.correlationId, correlationId))
    .orderBy(desc(aclLogs.createdAt))
}
