import { defineEventHandler } from 'h3'

import { deviceCredentialStatus } from '../../services/device-credential.service'
import { requireAuthenticatedUser } from '../../utils/auth'
import { useDatabase } from '../../utils/db'
import { ok } from '../../utils/envelope'

/**
 * GET /api/session/device-credentials — non-secret status for the UI:
 * `{ set, username? }`. Never returns the password.
 */
export default defineEventHandler(async (event) => {
  await requireAuthenticatedUser(event)
  return ok(await deviceCredentialStatus(useDatabase(), event))
})
