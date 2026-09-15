import { defineEventHandler, getRouterParam, readBody } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { AdminResetPasswordSchema } from '#shared/schemas/user.schema'
import { UserNotFoundError, resetUserPassword } from '../../../services/user.service'
import { assertSameOrigin, requirePermission } from '../../../utils/auth'
import { useDatabase } from '../../../utils/db'
import { apiError, ok } from '../../../utils/envelope'

/**
 * POST /api/users/:id/reset-password — set a new password. Requires
 * ADMINISTRATION_MANAGE.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  await requirePermission(event, PERMISSIONS.ADMINISTRATION_MANAGE)

  const id = getRouterParam(event, 'id')
  if (!id) throw apiError(404, 'NOT_FOUND', 'User not found')

  const parsed = AdminResetPasswordSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid password')
  }

  try {
    await resetUserPassword(useDatabase(), id, parsed.data)
    return ok({ status: 'RESET' as const })
  }
  catch (err) {
    if (err instanceof UserNotFoundError) throw apiError(404, 'NOT_FOUND', 'User not found')
    throw err
  }
})
