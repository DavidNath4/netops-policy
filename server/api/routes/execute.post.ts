import { defineEventHandler, readBody } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { RouteExecuteSchema } from '#shared/schemas/route.schema'
import { routeExecute } from '../../services/route.service'
import { assertSameOrigin, requirePermission } from '../../utils/auth'
import { buildAuditContext } from '../../utils/audit-context'
import { useDatabase } from '../../utils/db'
import { apiError, ok } from '../../utils/envelope'

/**
 * POST /api/routes/execute — confirmed route add/delete, executed via n8n.
 * Permission depends on the operation: ADD → ROUTES_ADD, DELETE → ROUTES_DELETE.
 * Records one SUCCESS/FAILED audit log with the correlation id.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)

  const parsed = RouteExecuteSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid route execute request')
  }

  const permission = parsed.data.operation === 'ADD'
    ? PERMISSIONS.ROUTES_ADD
    : PERMISSIONS.ROUTES_DELETE
  const user = await requirePermission(event, permission)

  const db = useDatabase()
  const ctx = await buildAuditContext(db, event, user)
  return ok(await routeExecute(db, ctx, parsed.data))
})
