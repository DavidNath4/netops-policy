import { defineEventHandler, getQuery } from 'h3'

import { AuditQuerySchema } from '#shared/schemas/audit.schema'
import { exportEntries } from '../../services/audit.service'
import { requireAuthenticatedUser } from '../../utils/auth'
import { useDatabase } from '../../utils/db'
import { apiError, ok } from '../../utils/envelope'

/**
 * GET /api/audit/export — the selected audit entries (filtered, unpaginated up
 * to a safe cap) for export. Available to every authenticated user.
 */
export default defineEventHandler(async (event) => {
  await requireAuthenticatedUser(event)

  const parsed = AuditQuerySchema.safeParse(getQuery(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid audit query')
  }

  return ok(await exportEntries(useDatabase(), parsed.data))
})
