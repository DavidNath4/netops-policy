import { defineEventHandler, readBody } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { RouteShowSchema } from '#shared/schemas/route.schema'
import { routeShow } from '../../services/route.service'
import { assertSameOrigin, requirePermission } from '../../utils/auth'
import { buildAuditContext } from '../../utils/audit-context'
import { useDatabase } from '../../utils/db'
import { apiError, ok } from '../../utils/envelope'

/**
 * POST /api/routes/show — read-only route show via n8n. Requires ROUTES_SHOW.
 * No confirmation step. Returns raw device output; records a SHOW audit log.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const user = await requirePermission(event, PERMISSIONS.ROUTES_SHOW)

  const parsed = RouteShowSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid route show request')
  }

  const db = useDatabase()
  const ctx = await buildAuditContext(db, event, user)
  return ok(await routeShow(db, ctx, parsed.data))
})
