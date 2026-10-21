import { defineEventHandler } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { listAclTimeRanges } from '../../services/acl.service'
import { assertSameOrigin, requirePermission } from '../../utils/auth'
import { ok } from '../../utils/envelope'

/**
 * GET /api/acl/time-ranges — list the device's existing time-range objects for
 * the ACL Add "Select Existing" dropdown. Read-only; gated by the same
 * permission as the Add page (ACL_POLICIES_ADD). The service delegates to the
 * n8n `time/show` helper, which never throws, so this always returns an
 * envelope (an empty `objects` list when n8n is unreachable).
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  await requirePermission(event, PERMISSIONS.ACL_POLICIES_ADD)
  return ok(await listAclTimeRanges())
})
