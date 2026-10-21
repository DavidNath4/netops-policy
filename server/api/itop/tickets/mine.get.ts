import { defineEventHandler } from 'h3'

import { ItopUnreachableError } from '../../../network/itop-client'
import { getMyOngoingItopTickets } from '../../../services/itop.service'
import { assertSameOrigin, requireAuthenticatedUser } from '../../../utils/auth'
import { apiError, ok } from '../../../utils/envelope'

/**
 * GET /api/itop/tickets/mine — the signed-in engineer's own ONGOING iTop
 * tickets (newest first), for the quick-pick list under the ticket search box.
 * Auth-only (a sub-step of an add/delete the user is already permitted to do);
 * no new RBAC permission.
 *
 * The iTop login is taken SERVER-SIDE from the authenticated user's `username`
 * (which equals `priv_user.login`); the client never supplies it. When the user
 * has no username or no ongoing assigned tickets, the list is empty.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const user = await requireAuthenticatedUser(event)

  try {
    return ok(await getMyOngoingItopTickets(user.username ?? null))
  }
  catch (e) {
    if (e instanceof ItopUnreachableError) {
      throw apiError(502, 'ITOP_UNREACHABLE', 'iTop is unreachable')
    }
    throw e
  }
})
