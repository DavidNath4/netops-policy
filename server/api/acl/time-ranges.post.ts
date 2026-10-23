import { defineEventHandler, readBody } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { TimeRangeListRequestSchema } from '#shared/schemas/time-range.schema'
import { listAclTimeRanges } from '../../services/acl.service'
import { assertSameOrigin, requirePermission } from '../../utils/auth'
import { apiError, ok } from '../../utils/envelope'

/**
 * POST /api/acl/time-ranges — list the device's existing time-range objects for
 * the ACL Add "Select Existing" dropdown. Read-only (no device change, no audit
 * row); gated by the same permission as the Add page (ACL_POLICIES_ADD).
 *
 * The n8n `time/show` webhook now authenticates, so the body carries the device
 * credentials typed on the Add page (POST, not GET, so they never appear in the
 * URL/logs). The service delegates to the n8n `time/show` helper, which never
 * throws, so this always returns an envelope (an empty `objects` list when n8n
 * is unreachable or the credentials are rejected).
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  await requirePermission(event, PERMISSIONS.ACL_POLICIES_ADD)

  const parsed = TimeRangeListRequestSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid time range list request')
  }

  return ok(await listAclTimeRanges(parsed.data))
})
