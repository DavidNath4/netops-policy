import { defineEventHandler } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { pingN8n } from '../../network/n8n-client'
import { assertSameOrigin, requirePermission } from '../../utils/auth'
import { ok } from '../../utils/envelope'

/**
 * POST /api/n8n/test — admin diagnostic. Lightweight connectivity probe of the
 * n8n host (no API key on the wire). Requires ADMINISTRATION_MANAGE. Never throws.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  await requirePermission(event, PERMISSIONS.ADMINISTRATION_MANAGE)
  return ok(await pingN8n())
})
