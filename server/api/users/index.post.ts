import { defineEventHandler, readBody } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { AdminCreateUserSchema } from '#shared/schemas/user.schema'
import { EmailTakenError, RoleNotFoundError, createUser } from '../../services/user.service'
import { assertSameOrigin, requirePermission } from '../../utils/auth'
import { useDatabase } from '../../utils/db'
import { apiError, ok } from '../../utils/envelope'

/**
 * POST /api/users — create a LOCAL user with a role. Requires
 * ADMINISTRATION_MANAGE.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  await requirePermission(event, PERMISSIONS.ADMINISTRATION_MANAGE)

  const parsed = AdminCreateUserSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid user details')
  }

  try {
    const user = await createUser(useDatabase(), parsed.data)
    return ok(user)
  }
  catch (err) {
    if (err instanceof EmailTakenError) {
      throw apiError(409, 'CONFLICT', 'A user with this email already exists')
    }
    if (err instanceof RoleNotFoundError) {
      throw apiError(400, 'VALIDATION_ERROR', 'Unknown role')
    }
    throw err
  }
})
