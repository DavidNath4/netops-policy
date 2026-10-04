import { defineEventHandler, readBody } from 'h3'

import { ItopTicketSearchSchema } from '#shared/schemas/itop.schema'
import { ItopUnreachableError } from '../../../network/itop-client'
import { searchItopTickets } from '../../../services/itop.service'
import { assertSameOrigin, requireAuthenticatedUser } from '../../../utils/auth'
import { apiError, ok } from '../../../utils/envelope'

/**
 * POST /api/itop/tickets/search — read-only iTop ticket search by ref/title
 * across all types. Auth-only (a sub-step of an add/delete the user is already
 * permitted to do); no new RBAC permission.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  await requireAuthenticatedUser(event)

  const parsed = ItopTicketSearchSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid ticket search request')
  }

  try {
    return ok(await searchItopTickets(parsed.data))
  }
  catch (e) {
    if (e instanceof ItopUnreachableError) {
      throw apiError(502, 'ITOP_UNREACHABLE', 'iTop is unreachable')
    }
    throw e
  }
})
