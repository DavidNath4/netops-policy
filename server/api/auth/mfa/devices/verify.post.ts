import { defineEventHandler, readBody } from 'h3'

import { VerifyMfaDeviceSchema } from '#shared/schemas/mfa.schema'
import { verifyAddMfaDevice } from '../../../../services/auth.service'
import { requireAuthenticatedUser, assertSameOrigin } from '../../../../utils/auth'
import { useDatabase } from '../../../../utils/db'
import { apiError, ok } from '../../../../utils/envelope'

/**
 * POST /api/auth/mfa/devices/verify — confirm a newly-enrolled device.
 *
 * Post-auth (requires a session). Verifies the first 6-digit code against the
 * pending device identified by `mfaId`; on success the device becomes enabled.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const user = await requireAuthenticatedUser(event)

  const parsed = VerifyMfaDeviceSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(400, 'INVALID_VERIFICATION_CODE', 'Invalid verification code')
  }

  const db = useDatabase()
  const valid = await verifyAddMfaDevice(db, user.userId, parsed.data.mfaId, parsed.data.code)
  if (!valid) {
    throw apiError(400, 'INVALID_VERIFICATION_CODE', 'Invalid verification code')
  }

  return ok({ status: 'VERIFIED' as const })
})
