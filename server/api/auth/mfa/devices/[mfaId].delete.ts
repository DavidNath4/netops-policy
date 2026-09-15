import { defineEventHandler, getRouterParam } from 'h3'

import { deleteMfaDevice, MfaDeviceRuleError } from '../../../../services/auth.service'
import { requireAuthenticatedUser, assertSameOrigin } from '../../../../utils/auth'
import { useDatabase } from '../../../../utils/db'
import { apiError, ok } from '../../../../utils/envelope'

/**
 * DELETE /api/auth/mfa/devices/:mfaId — remove one of the user's MFA devices.
 *
 * Post-auth (requires a session). Refuses to remove the user's last confirmed
 * device (they must always keep at least one) and unknown device ids.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const user = await requireAuthenticatedUser(event)

  const mfaId = getRouterParam(event, 'mfaId')
  if (!mfaId || !/^[0-9a-f-]{36}$/i.test(mfaId)) {
    throw apiError(404, 'MFA_DEVICE_NOT_FOUND', 'MFA device not found')
  }

  const db = useDatabase()
  try {
    await deleteMfaDevice(db, user.userId, mfaId)
    return ok({ status: 'DELETED' as const })
  }
  catch (err) {
    if (err instanceof MfaDeviceRuleError) {
      if (err.rule === 'LAST_DEVICE') {
        throw apiError(409, 'MFA_LAST_DEVICE', 'You must keep at least one MFA device')
      }
      throw apiError(404, 'MFA_DEVICE_NOT_FOUND', 'MFA device not found')
    }
    throw err
  }
})
