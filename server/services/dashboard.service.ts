import { count, desc, eq, sql } from 'drizzle-orm'

import type { Database } from '~~/database'
import { auditLogs } from '~~/database/schema/audit-logs'
import { toAuditResponse } from './audit.service'
import type { AuditResponse } from '#shared/schemas/audit.schema'

/**
 * Dashboard summary — derived entirely from `audit_logs`.
 *
 * This app is not the source of truth for ACL/route configuration, so the
 * dashboard summarizes ACTIVITY (executions and their outcomes), not counts of
 * ACLs/routes on devices.
 */

export interface DashboardSummary {
  totalExecutions: number
  successCount: number
  failedCount: number
  perModule: { module: string, count: number }[]
  recentActivities: AuditResponse[]
  failedRecent: AuditResponse[]
}

export async function summary(db: Database): Promise<DashboardSummary> {
  // Total + status breakdown in one grouped query.
  const statusRows = await db
    .select({ status: auditLogs.status, value: count() })
    .from(auditLogs)
    .groupBy(auditLogs.status)

  let successCount = 0
  let failedCount = 0
  for (const r of statusRows) {
    if (r.status === 'SUCCESS') successCount = r.value
    else if (r.status === 'FAILED') failedCount = r.value
  }
  const totalExecutions = successCount + failedCount

  // Activity per module.
  const moduleRows = await db
    .select({ module: auditLogs.module, value: count() })
    .from(auditLogs)
    .groupBy(auditLogs.module)
    .orderBy(desc(sql`count(*)`))

  const perModule = moduleRows.map(r => ({ module: r.module, count: r.value }))

  // Most recent activity (any module) and most recent failures.
  const recent = await db
    .select()
    .from(auditLogs)
    .orderBy(desc(auditLogs.createdAt))
    .limit(10)

  const failed = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.status, 'FAILED'))
    .orderBy(desc(auditLogs.createdAt))
    .limit(10)

  return {
    totalExecutions,
    successCount,
    failedCount,
    perModule,
    recentActivities: recent.map(toAuditResponse),
    failedRecent: failed.map(toAuditResponse),
  }
}
