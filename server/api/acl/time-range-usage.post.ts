import { defineEventHandler, readBody } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { TimeRangeUsageCheckSchema } from '#shared/schemas/time-range.schema'
import { checkAclTimeRangeUsage } from '../../services/acl.service'
import { assertSameOrigin, requirePermission } from '../../utils/auth'
import { apiError, ok } from '../../utils/envelope'

/**
 * POST /api/acl/time-range-usage — check whether the time-range object(s)
 * referenced by an ACL being deleted are still used by OTHER ACL rules, for the
 * ACL DELETE "Generate" advisory warning. Read-only (no device change, no audit
 * row); gated by ACL_POLICIES_DELETE since it is a sub-step of the delete flow.
 *
 * The body carries the object name(s) plus the device credentials typed on the
 * delete page (POST, not GET, so the credentials are never in the URL/logs). The
 * service delegates to the n8n `time/isUsed` helper, which never throws, so this
 * always returns an envelope (an empty `usages` list when n8n is unreachable).
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  await requirePermission(event, PERMISSIONS.ACL_POLICIES_DELETE)

  const parsed = TimeRangeUsageCheckSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid time range usage request')
  }

  return ok(await checkAclTimeRangeUsage(parsed.data))
})
