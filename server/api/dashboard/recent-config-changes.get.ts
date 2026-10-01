import { defineEventHandler } from 'h3'

import { getRecentConfigChanges } from '../../services/dashboard.service'
import { requireAuthenticatedUser } from '../../utils/auth'
import { useDatabase } from '../../utils/db'
import { ok } from '../../utils/envelope'

/**
 * GET /api/dashboard/recent-config-changes — newest config mutations (safe
 * projection) from audit_logs. Available to every authenticated user (no
 * feature permission).
 */
export default defineEventHandler(async (event) => {
  await requireAuthenticatedUser(event)
  return ok(await getRecentConfigChanges(useDatabase()))
})
