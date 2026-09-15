import { defineEventHandler, getRouterParam, readBody } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { AdminChangeRoleSchema } from '#shared/schemas/user.schema'
import { RoleNotFoundError, UserNotFoundError, changeUserRole } from '../../../services/user.service'
import { assertSameOrigin, requirePermission } from '../../../utils/auth'
import { useDatabase } from '../../../utils/db'
import { apiError, ok } from '../../../utils/envelope'

/**
 * PATCH /api/users/:id/role — change a user's single role. Requires
 * ADMINISTRATION_MANAGE.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  await requirePermission(event, PERMISSIONS.ADMINISTRATION_MANAGE)

  const id = getRouterParam(event, 'id')
  if (!id) throw apiError(404, 'NOT_FOUND', 'User not found')

  const parsed = AdminChangeRoleSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid role')
  }

  try {
    const user = await changeUserRole(useDatabase(), id, parsed.data)
    return ok(user)
  }
  catch (err) {
    if (err instanceof UserNotFoundError) throw apiError(404, 'NOT_FOUND', 'User not found')
    if (err instanceof RoleNotFoundError) throw apiError(400, 'VALIDATION_ERROR', 'Unknown role')
    throw err
  }
})
