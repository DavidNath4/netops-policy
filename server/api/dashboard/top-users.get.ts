import { defineEventHandler } from 'h3'

import { getTopUsers } from '../../services/dashboard.service'
import { requireAuthenticatedUser } from '../../utils/auth'
import { useDatabase } from '../../utils/db'
import { ok } from '../../utils/envelope'

/**
 * GET /api/dashboard/top-users — most active users (grouped by username) from
 * audit_logs. Available to every authenticated user (no feature permission).
 */
export default defineEventHandler(async (event) => {
  await requireAuthenticatedUser(event)
  return ok(await getTopUsers(useDatabase()))
})
