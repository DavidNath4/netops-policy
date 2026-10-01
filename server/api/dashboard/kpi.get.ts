import { defineEventHandler } from 'h3'

import { getKpi } from '../../services/dashboard.service'
import { requireAuthenticatedUser } from '../../utils/auth'
import { useDatabase } from '../../utils/db'
import { ok } from '../../utils/envelope'

/**
 * GET /api/dashboard/kpi — three KPI cards (this month vs last month) from
 * audit_logs. Available to every authenticated user (no feature permission).
 */
export default defineEventHandler(async (event) => {
  await requireAuthenticatedUser(event)
  return ok(await getKpi(useDatabase()))
})
