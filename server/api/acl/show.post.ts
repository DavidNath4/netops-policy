import { defineEventHandler, readBody } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { AclShowSchema } from '#shared/schemas/acl.schema'
import { aclShow } from '../../services/acl.service'
import { assertSameOrigin, requirePermission } from '../../utils/auth'
import { buildAuditContext } from '../../utils/audit-context'
import { useDatabase } from '../../utils/db'
import { apiError, ok } from '../../utils/envelope'

/**
 * POST /api/acl/show — read-only ACL show via n8n. Requires ACL_POLICIES_SHOW.
 * No confirmation step. Returns raw device output; records a SHOW audit log.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const user = await requirePermission(event, PERMISSIONS.ACL_POLICIES_SHOW)

  const parsed = AclShowSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid ACL show request')
  }

  const db = useDatabase()
  const ctx = await buildAuditContext(db, event, user)
  return ok(await aclShow(db, ctx, parsed.data))
})
