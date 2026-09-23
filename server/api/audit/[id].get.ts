import { defineEventHandler, getRouterParam } from 'h3'

import { getById } from '../../services/audit.service'
import { requireAuthenticatedUser } from '../../utils/auth'
import { useDatabase } from '../../utils/db'
import { apiError, ok } from '../../utils/envelope'

/**
 * GET /api/audit/:id — one audit entry (detail view with the 4 JSONB payloads).
 * Available to every authenticated user.
 */
export default defineEventHandler(async (event) => {
  await requireAuthenticatedUser(event)

  const id = getRouterParam(event, 'id')
  if (!id) {
    throw apiError(400, 'VALIDATION_ERROR', 'Missing audit id')
  }

  const entry = await getById(useDatabase(), id)
  if (!entry) {
    throw apiError(404, 'NOT_FOUND', 'Audit entry not found')
  }

  return ok(entry)
})
