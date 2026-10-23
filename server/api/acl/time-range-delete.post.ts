import { defineEventHandler, readBody } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { TimeRangeDeleteSchema } from '#shared/schemas/time-range.schema'
import { deleteTimeRange } from '../../services/acl.service'
import { getDeviceCredentials } from '../../services/device-credential.service'
import { assertSameOrigin, requirePermission } from '../../utils/auth'
import { buildAuditContext } from '../../utils/audit-context'
import { useDatabase } from '../../utils/db'
import { apiError, ok } from '../../utils/envelope'

/**
 * POST /api/acl/time-range-delete — safely delete a standalone time-range object
 * via n8n `time/safeDelete`. Requires ACL_POLICIES_DELETE (a destructive device
 * write; NOC does not have it, matching the app's delete posture). n8n refuses
 * when ACL rules still use the object (returned as blockingRules so the page can
 * warn). Records one TIME_RANGE/DELETE audit row. Credentials are auto-filled
 * from the caller's Device Session Credentials.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const user = await requirePermission(event, PERMISSIONS.ACL_POLICIES_DELETE)

  const parsed = TimeRangeDeleteSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid time range delete request', parsed.error.flatten().fieldErrors)
  }

  const db = useDatabase()
  const creds = await getDeviceCredentials(db, event)
  if (!creds) {
    throw apiError(400, 'DEVICE_CREDENTIALS_REQUIRED', 'Enter your device credentials to delete a time range')
  }

  const ctx = await buildAuditContext(db, event, user)
  return ok(await deleteTimeRange(db, ctx, parsed.data, creds))
})
