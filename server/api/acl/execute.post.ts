import { defineEventHandler, readBody } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { AclExecuteSchema } from '#shared/schemas/acl.schema'
import { aclExecute } from '../../services/acl.service'
import { assertSameOrigin, requirePermission } from '../../utils/auth'
import { buildAuditContext } from '../../utils/audit-context'
import { useDatabase } from '../../utils/db'
import { apiError, ok } from '../../utils/envelope'

/**
 * POST /api/acl/execute — confirmed ACL add/delete, executed via n8n. Permission
 * depends on the operation: ADD → ACL_POLICIES_ADD, DELETE → ACL_POLICIES_DELETE.
 * Records one SUCCESS/FAILED audit log with the correlation id.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)

  const parsed = AclExecuteSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid ACL execute request')
  }

  const permission = parsed.data.operation === 'ADD'
    ? PERMISSIONS.ACL_POLICIES_ADD
    : PERMISSIONS.ACL_POLICIES_DELETE
  const user = await requirePermission(event, permission)

  const db = useDatabase()
  const ctx = await buildAuditContext(db, event, user)
  return ok(await aclExecute(db, ctx, parsed.data))
})
