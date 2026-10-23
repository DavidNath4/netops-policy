import { defineEventHandler, readBody } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { AclBulkExecuteSchema } from '#shared/schemas/acl.schema'
import { aclBulkExecute } from '../../services/acl.service'
import { assertSameOrigin, requirePermission } from '../../utils/auth'
import { buildAuditContext } from '../../utils/audit-context'
import { useDatabase } from '../../utils/db'
import { apiError, ok } from '../../utils/envelope'

/**
 * POST /api/acl/bulk-execute — add several ACL pairs in one batch under one iTop
 * ticket and one set of credentials, executed via n8n. All-or-nothing gate: the
 * batch is rejected (409 ACL_BULK_HAS_BLOCKING) if any row already exists or
 * uses Source = Destination; otherwise every row runs via the existing
 * per-direction path, each writing its own audit row. ADD only, so it always
 * requires ACL_POLICIES_ADD.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)

  const parsed = AclBulkExecuteSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid bulk ACL execute request', parsed.error.flatten().fieldErrors)
  }

  const user = await requirePermission(event, PERMISSIONS.ACL_POLICIES_ADD)

  const db = useDatabase()
  const ctx = await buildAuditContext(db, event, user)
  return ok(await aclBulkExecute(db, ctx, parsed.data))
})
