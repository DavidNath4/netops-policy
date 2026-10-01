import { defineEventHandler, getQuery } from 'h3'

import { RouteLogQuerySchema } from '#shared/schemas/exec-log.schema'
import { list } from '../../services/route-log.service'
import { requireAuthenticatedUser } from '../../utils/auth'
import { useDatabase } from '../../utils/db'
import { apiError, ok } from '../../utils/envelope'

/**
 * GET /api/route-logs — paginated, filtered ROUTE execution-inspection detail
 * list (accepts a changeTicket filter). Available to every authenticated user
 * (no feature permission required), like /api/audit.
 */
export default defineEventHandler(async (event) => {
  await requireAuthenticatedUser(event)

  const parsed = RouteLogQuerySchema.safeParse(getQuery(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid route log query')
  }

  return ok(await list(useDatabase(), parsed.data))
})
