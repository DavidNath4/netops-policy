import { defineEventHandler, getRouterParam } from 'h3'

import { CorrelationIdSchema } from '#shared/schemas/common.schema'
import { getByCorrelationId } from '../../../services/acl-log.service'
import { requireAuthenticatedUser } from '../../../utils/auth'
import { useDatabase } from '../../../utils/db'
import { apiError, ok } from '../../../utils/envelope'

/**
 * GET /api/acl-logs/correlation/:id — all ACL detail rows for one operation,
 * for the inspection panel. An empty array is a valid 200 (not 404). Available
 * to every authenticated user.
 */
export default defineEventHandler(async (event) => {
  await requireAuthenticatedUser(event)

  const parsed = CorrelationIdSchema.safeParse(getRouterParam(event, 'id'))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid correlation id')
  }

  return ok(await getByCorrelationId(useDatabase(), parsed.data))
})
