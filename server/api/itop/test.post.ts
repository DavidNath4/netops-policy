import { defineEventHandler } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { pingItop } from '../../network/itop-client'
import { assertSameOrigin, requirePermission } from '../../utils/auth'
import { ok } from '../../utils/envelope'

/**
 * POST /api/itop/test — admin diagnostic. Runs a read-only SELECT 1 against iTop
 * and returns { ok, message }. Requires ADMINISTRATION_MANAGE. Never throws.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  await requirePermission(event, PERMISSIONS.ADMINISTRATION_MANAGE)
  return ok(await pingItop())
})
