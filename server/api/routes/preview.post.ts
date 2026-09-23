import { defineEventHandler, readBody } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { RoutePreviewSchema } from '#shared/schemas/route.schema'
import { routePreview } from '../../services/route.service'
import { assertSameOrigin, requirePermission } from '../../utils/auth'
import { apiError, ok } from '../../utils/envelope'

/**
 * POST /api/routes/preview — build the redacted command preview for a route
 * add/delete (display only, no n8n call, no audit). Permission depends on the
 * operation: ADD → ROUTES_ADD, DELETE → ROUTES_DELETE.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)

  const parsed = RoutePreviewSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid route preview request')
  }

  const permission = parsed.data.operation === 'ADD'
    ? PERMISSIONS.ROUTES_ADD
    : PERMISSIONS.ROUTES_DELETE
  await requirePermission(event, permission)

  const { text, command } = routePreview(parsed.data)
  return ok({ preview: text, command })
})
