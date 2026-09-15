import { defineEventHandler, getQuery } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { listUsers } from '../../services/user.service'
import { requirePermission } from '../../utils/auth'
import { useDatabase } from '../../utils/db'
import { ok } from '../../utils/envelope'

/**
 * GET /api/users — paginated user list (Administration). Requires
 * ADMINISTRATION_SHOW. Supports ?page, ?limit, ?search.
 */
export default defineEventHandler(async (event) => {
  await requirePermission(event, PERMISSIONS.ADMINISTRATION_SHOW)

  const q = getQuery(event)
  const page = Math.max(1, Number.parseInt(String(q.page ?? '1'), 10) || 1)
  const limitRaw = Number.parseInt(String(q.limit ?? '20'), 10) || 20
  const limit = Math.min(100, Math.max(1, limitRaw))
  const search = typeof q.search === 'string' ? q.search : undefined

  const result = await listUsers(useDatabase(), { page, limit, search })
  return ok(result)
})
