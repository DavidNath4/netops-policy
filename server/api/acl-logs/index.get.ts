import { defineEventHandler, getQuery } from 'h3'

import { AclLogQuerySchema } from '#shared/schemas/exec-log.schema'
import { list } from '../../services/acl-log.service'
import { requireAuthenticatedUser } from '../../utils/auth'
import { useDatabase } from '../../utils/db'
import { apiError, ok } from '../../utils/envelope'

/**
 * GET /api/acl-logs — paginated, filtered ACL execution-inspection detail list.
 * Available to every authenticated user (no feature permission required), like
 * /api/audit.
 */
export default defineEventHandler(async (event) => {
  await requireAuthenticatedUser(event)

  const parsed = AclLogQuerySchema.safeParse(getQuery(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid ACL log query')
  }

  return ok(await list(useDatabase(), parsed.data))
})
