import { defineEventHandler } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { listTimeRangeOverview } from '../../services/acl.service'
import { getDeviceCredentials } from '../../services/device-credential.service'
import { assertSameOrigin, requirePermission } from '../../utils/auth'
import { useDatabase } from '../../utils/db'
import { apiError, ok } from '../../utils/envelope'

/**
 * POST /api/acl/time-range-overview — list every device time-range object with
 * its end detail and ACL-rule usage, for the Time Range page table + usage
 * pop-up. Read-only (no audit). Requires ACL_POLICIES_SHOW (admin, L2, NOC).
 * Credentials are auto-filled from the caller's Device Session Credentials; if
 * none are set/valid it returns DEVICE_CREDENTIALS_REQUIRED.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  await requirePermission(event, PERMISSIONS.ACL_POLICIES_SHOW)

  const db = useDatabase()
  const creds = await getDeviceCredentials(db, event)
  if (!creds) {
    throw apiError(400, 'DEVICE_CREDENTIALS_REQUIRED', 'Enter your device credentials to view time ranges')
  }

  return ok(await listTimeRangeOverview(creds))
})
