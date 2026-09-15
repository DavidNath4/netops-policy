import { defineEventHandler } from 'h3'

import { listMfaDevices } from '../../../../services/auth.service'
import { requireAuthenticatedUser } from '../../../../utils/auth'
import { useDatabase } from '../../../../utils/db'
import { ok } from '../../../../utils/envelope'

/**
 * GET /api/auth/mfa/devices — list the signed-in user's MFA devices.
 *
 * Post-auth (requires a session). Returns the safe device shape only; the
 * encrypted TOTP secret never leaves the server.
 */
export default defineEventHandler(async (event) => {
  const user = await requireAuthenticatedUser(event)
  const db = useDatabase()
  const devices = await listMfaDevices(db, user.userId)
  return ok({ devices })
})
