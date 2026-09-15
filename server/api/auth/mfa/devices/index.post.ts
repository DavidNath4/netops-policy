import { defineEventHandler, readBody } from 'h3'

import { AddMfaDeviceSchema } from '#shared/schemas/mfa.schema'
import { MfaDeviceRuleError, prepareAddMfaDevice } from '../../../../services/auth.service'
import { requireAuthenticatedUser, assertSameOrigin } from '../../../../utils/auth'
import { useDatabase } from '../../../../utils/db'
import { apiError, ok } from '../../../../utils/envelope'

/**
 * POST /api/auth/mfa/devices — begin enrolling an ADDITIONAL MFA device.
 *
 * Post-auth (requires a session). Enforces the max-2 rule; on success returns
 * the new pending device id plus the otpauth:// URI to render as a QR code.
 * The device is not usable until confirmed via the verify endpoint.
 *
 * SECURITY: the otpauth URI carries the TOTP secret — returned only to the
 * authenticated owner, never logged or persisted in plaintext.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const user = await requireAuthenticatedUser(event)

  const parsed = AddMfaDeviceSchema.safeParse((await readBody(event)) ?? {})
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid device details')
  }

  const db = useDatabase()
  try {
    const { mfaId, otpauthUri } = await prepareAddMfaDevice(db, user.userId, parsed.data.label)
    return ok({ mfaId, otpauthUri })
  }
  catch (err) {
    if (err instanceof MfaDeviceRuleError && err.rule === 'LIMIT_REACHED') {
      throw apiError(409, 'MFA_DEVICE_LIMIT_REACHED', 'You can have at most two MFA devices')
    }
    throw err
  }
})
