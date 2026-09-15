import { defineEventHandler } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { listRoleOptions } from '../../services/user.service'
import { requirePermission } from '../../utils/auth'
import { useDatabase } from '../../utils/db'
import { ok } from '../../utils/envelope'

/**
 * GET /api/roles — active roles for the Administration role dropdown. Requires
 * ADMINISTRATION_SHOW (only the admin screen needs it).
 */
export default defineEventHandler(async (event) => {
  await requirePermission(event, PERMISSIONS.ADMINISTRATION_SHOW)
  const roles = await listRoleOptions(useDatabase())
  return ok({ roles })
})
