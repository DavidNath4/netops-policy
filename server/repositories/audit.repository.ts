import { and, count, desc, eq, getTableColumns, gte, ilike, lte, or } from 'drizzle-orm'

import type { Database, DbOrTx } from '~~/database'
import { auditLogs } from '~~/database/schema/audit-logs'
import { users } from '~~/database/schema/users'

/**
 * Data-access layer for the `audit_logs` table — the app's system of record.
 *
 * Repositories only talk to the database. This one intentionally exposes NO
 * update or delete: audit rows are immutable during normal operation. Values
 * inserted here are already redacted by the audit service.
 */

export type AuditRow = typeof auditLogs.$inferSelect
export type InsertAuditLog = typeof auditLogs.$inferInsert

/** Insert one audit row. Values must already be redacted (no raw secrets). */
export async function insertAudit(db: DbOrTx, input: InsertAuditLog): Promise<AuditRow> {
  const [row] = await db.insert(auditLogs).values(input).returning()
  if (!row) {
    throw new Error('Failed to write audit log: no row returned from insert')
  }
  return row
}

export interface AuditListFilter {
  page: number
  limit: number
  search?: string
  module?: AuditRow['module']
  action?: AuditRow['action']
  status?: AuditRow['status']
  changeTicket?: string
  correlationId?: string
  from?: Date
  to?: Date
}

/** Paginated, filtered audit list, newest first. */
export async function listAudit(
  db: Database,
  filter: AuditListFilter,
): Promise<{ items: AuditRow[], total: number }> {
  const conditions = []

  if (filter.module) conditions.push(eq(auditLogs.module, filter.module))
  if (filter.action) conditions.push(eq(auditLogs.action, filter.action))
  if (filter.status) conditions.push(eq(auditLogs.status, filter.status))
  if (filter.correlationId) conditions.push(eq(auditLogs.correlationId, filter.correlationId))
  if (filter.changeTicket) conditions.push(eq(auditLogs.changeTicket, filter.changeTicket))
  if (filter.from) conditions.push(gte(auditLogs.createdAt, filter.from))
  if (filter.to) conditions.push(lte(auditLogs.createdAt, filter.to))

  const search = filter.search?.trim()
  if (search) {
    const like = `%${search}%`
    // Match the actor's snapshot username/ticket on the audit row AND the
    // joined user's current display name / email.
    conditions.push(
      or(
        ilike(auditLogs.username, like),
        ilike(auditLogs.changeTicket, like),
        ilike(users.displayName, like),
        ilike(users.email, like),
      ),
    )
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined

  // LEFT JOIN users (auditLogs.userId is nullable for failed logins). The join is
  // applied unconditionally; with no users-filter it never changes counts/rows,
  // and it lets `search` also match the joined user's display name / email. We
  // select ONLY audit columns (getTableColumns) so the row shape stays AuditRow
  // and toAuditResponse is unchanged.
  const [{ value: total } = { value: 0 }] = await db
    .select({ value: count() })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.userId))
    .where(where)

  const items = await db
    .select(getTableColumns(auditLogs))
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.userId))
    .where(where)
    .orderBy(desc(auditLogs.createdAt))
    .limit(filter.limit)
    .offset((filter.page - 1) * filter.limit)

  return { items, total }
}

/** Fetch a single audit row by id, or undefined. */
export function findAuditById(db: Database, id: string): Promise<AuditRow | undefined> {
  return db.query.auditLogs.findFirst({ where: eq(auditLogs.id, id) })
}
