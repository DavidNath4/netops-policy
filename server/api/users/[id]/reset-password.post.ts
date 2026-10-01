import { defineEventHandler } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { assertSameOrigin, requirePermission } from '../../../utils/auth'
import { apiError } from '../../../utils/envelope'

/**
 * POST /api/users/:id/reset-password — DISABLED. Passwords are managed in
 * Active Directory, so the app never resets them.
 *
 * The route is kept (with its origin + ADMINISTRATION_MANAGE checks) so the
 * contract stays stable, but it rejects before changing anything. To re-enable,
 * restore the AdminResetPasswordSchema validation and resetUserPassword(...)
 * call (see git history).
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  await requirePermission(event, PERMISSIONS.ADMINISTRATION_MANAGE)

  throw apiError(403, 'FORBIDDEN', 'Password reset is disabled; passwords are managed in Active Directory')
})
