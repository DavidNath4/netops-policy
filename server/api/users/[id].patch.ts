import { defineEventHandler, getRouterParam, readBody } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { AdminUpdateUserSchema } from '#shared/schemas/user.schema'
import { UserNotFoundError, updateUserBasic } from '../../services/user.service'
import { assertSameOrigin, requirePermission } from '../../utils/auth'
import { useDatabase } from '../../utils/db'
import { apiError, ok } from '../../utils/envelope'

/**
 * PATCH /api/users/:id — update basic info (display name). Requires
 * ADMINISTRATION_MANAGE.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  await requirePermission(event, PERMISSIONS.ADMINISTRATION_MANAGE)

  const id = getRouterParam(event, 'id')
  if (!id) throw apiError(404, 'NOT_FOUND', 'User not found')

  const parsed = AdminUpdateUserSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid user details')
  }

  try {
    const user = await updateUserBasic(useDatabase(), id, parsed.data)
    return ok(user)
  }
  catch (err) {
    if (err instanceof UserNotFoundError) throw apiError(404, 'NOT_FOUND', 'User not found')
    throw err
  }
})
