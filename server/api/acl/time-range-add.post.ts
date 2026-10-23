import { defineEventHandler, readBody } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { TimeRangeAddSchema } from '#shared/schemas/time-range.schema'
import { createTimeRange } from '../../services/acl.service'
import { getDeviceCredentials } from '../../services/device-credential.service'
import { assertSameOrigin, requirePermission } from '../../utils/auth'
import { buildAuditContext } from '../../utils/audit-context'
import { useDatabase } from '../../utils/db'
import { apiError, ok } from '../../utils/envelope'

/**
 * POST /api/acl/time-range-add — create a standalone time-range object on the
 * device via n8n `time/add`. Requires ACL_POLICIES_ADD (a device write). The
 * server derives the object name (date mode) or takes the typed name (named
 * mode), rejects a duplicate name (409 TIME_RANGE_EXISTS), delegates to n8n, and
 * records one TIME_RANGE/ADD audit row. Credentials are auto-filled from the
 * caller's Device Session Credentials.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const user = await requirePermission(event, PERMISSIONS.ACL_POLICIES_ADD)

  const parsed = TimeRangeAddSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid time range add request', parsed.error.flatten().fieldErrors)
  }

  const db = useDatabase()
  const creds = await getDeviceCredentials(db, event)
  if (!creds) {
    throw apiError(400, 'DEVICE_CREDENTIALS_REQUIRED', 'Enter your device credentials to add a time range')
  }

  const ctx = await buildAuditContext(db, event, user)
  return ok(await createTimeRange(db, ctx, parsed.data, creds))
})
