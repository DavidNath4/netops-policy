import { defineEventHandler, readBody } from 'h3'

import { DeviceCredentialsSchema } from '#shared/schemas/n8n.schema'
import { setDeviceCredentials } from '../../services/device-credential.service'
import { validateDeviceCredentials } from '../../network/n8n-client'
import { assertSameOrigin, requireAuthenticatedUser } from '../../utils/auth'
import { useDatabase } from '../../utils/db'
import { apiError, ok } from '../../utils/envelope'

/**
 * POST /api/session/device-credentials — validate the caller's device
 * credentials against n8n (`user/validate`), and only on success encrypt + store
 * them on the session row (valid for the life of the session). Read-path
 * convenience for ACL/Route search (n8n Integration Req 11).
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  await requireAuthenticatedUser(event)

  const parsed = DeviceCredentialsSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid device credentials')
  }

  // Validate once against n8n; only store working credentials.
  const validation = await validateDeviceCredentials(parsed.data.username, parsed.data.password)
  if (!validation.success) {
    throw apiError(401, 'INVALID_CREDENTIALS', validation.message)
  }

  await setDeviceCredentials(useDatabase(), event, parsed.data)
  return ok({ set: true })
})
