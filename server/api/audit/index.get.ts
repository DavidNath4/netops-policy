import { defineEventHandler, getQuery } from 'h3'

import { AuditQuerySchema } from '#shared/schemas/audit.schema'
import { list } from '../../services/audit.service'
import { requireAuthenticatedUser } from '../../utils/auth'
import { useDatabase } from '../../utils/db'
import { apiError, ok } from '../../utils/envelope'

/**
 * GET /api/audit — paginated, filtered Log Trail. Available to every
 * authenticated user (no feature permission required).
 */
export default defineEventHandler(async (event) => {
  await requireAuthenticatedUser(event)

  const parsed = AuditQuerySchema.safeParse(getQuery(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid audit query')
  }

  return ok(await list(useDatabase(), parsed.data))
})
