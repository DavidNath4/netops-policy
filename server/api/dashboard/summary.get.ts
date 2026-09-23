import { defineEventHandler } from 'h3'

import { summary } from '../../services/dashboard.service'
import { requireAuthenticatedUser } from '../../utils/auth'
import { useDatabase } from '../../utils/db'
import { ok } from '../../utils/envelope'

/**
 * GET /api/dashboard/summary — activity/execution summary from audit_logs.
 * Available to every authenticated user (no feature permission required).
 */
export default defineEventHandler(async (event) => {
  await requireAuthenticatedUser(event)
  return ok(await summary(useDatabase()))
})
