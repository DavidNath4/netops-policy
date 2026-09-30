import { defineEventHandler } from 'h3'

import { clearDeviceCredentials } from '../../services/device-credential.service'
import { assertSameOrigin, requireAuthenticatedUser } from '../../utils/auth'
import { useDatabase } from '../../utils/db'
import { ok } from '../../utils/envelope'

/**
 * DELETE /api/session/device-credentials — clear the caller's device
 * credentials immediately.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  await requireAuthenticatedUser(event)

  await clearDeviceCredentials(useDatabase(), event)
  return ok({ set: false })
})
