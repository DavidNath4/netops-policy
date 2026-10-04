import { defineEventHandler, readBody } from 'h3'

import { ItopTicketRefSchema } from '#shared/schemas/itop.schema'
import { ItopUnreachableError } from '../../../network/itop-client'
import { getItopTicketDetail } from '../../../services/itop.service'
import { assertSameOrigin, requireAuthenticatedUser } from '../../../utils/auth'
import { apiError, ok } from '../../../utils/envelope'

/**
 * POST /api/itop/tickets/preview — read-only single-ticket detail by ref.
 * Auth-only (no new RBAC permission). Returns NOT_FOUND when no ticket matches.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  await requireAuthenticatedUser(event)

  const parsed = ItopTicketRefSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid ticket preview request')
  }

  try {
    const detail = await getItopTicketDetail(parsed.data.ref)
    if (!detail) {
      throw apiError(404, 'NOT_FOUND', 'Ticket not found')
    }
    return ok(detail)
  }
  catch (e) {
    if (e instanceof ItopUnreachableError) {
      throw apiError(502, 'ITOP_UNREACHABLE', 'iTop is unreachable')
    }
    throw e
  }
})
