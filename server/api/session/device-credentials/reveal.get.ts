import { defineEventHandler } from 'h3'

import { getDeviceCredentials } from '../../../services/device-credential.service'
import { requireAuthenticatedUser } from '../../../utils/auth'
import { useDatabase } from '../../../utils/db'
import { apiError, ok } from '../../../utils/envelope'

/**
 * GET /api/session/device-credentials/reveal — return the caller's own device
 * credentials for the password eye-toggle. Owner-scoped (resolved from the
 * caller's session cookie); never exposes another user's credentials, never
 * logged, never audited.
 */
export default defineEventHandler(async (event) => {
  await requireAuthenticatedUser(event)

  const creds = await getDeviceCredentials(useDatabase(), event)
  if (!creds) {
    throw apiError(404, 'NOT_FOUND', 'No device credentials set for this session')
  }
  return ok({ username: creds.username, password: creds.password })
})
