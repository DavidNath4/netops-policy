import { defineEventHandler } from 'h3'

import { getConfigByOperation } from '../../services/dashboard.service'
import { requireAuthenticatedUser } from '../../utils/auth'
import { useDatabase } from '../../utils/db'
import { ok } from '../../utils/envelope'

/**
 * GET /api/dashboard/config-by-operation — the fixed four config operations
 * (zero-filled) from audit_logs. Available to every authenticated user (no
 * feature permission).
 */
export default defineEventHandler(async (event) => {
  await requireAuthenticatedUser(event)
  return ok(await getConfigByOperation(useDatabase()))
})
