import { defineEventHandler, readBody } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { RouteShowSchema } from '#shared/schemas/route.schema'
import { routeShow } from '../../services/route.service'
import { getDeviceCredentials } from '../../services/device-credential.service'
import { assertSameOrigin, requirePermission } from '../../utils/auth'
import { buildAuditContext } from '../../utils/audit-context'
import { useDatabase } from '../../utils/db'
import { apiError, ok } from '../../utils/envelope'

/**
 * POST /api/routes/show — search-only route show via n8n. Requires ROUTES_SHOW.
 * No confirmation. Credentials are auto-filled from the caller's Device Session
 * Credentials; if none are set/valid it returns DEVICE_CREDENTIALS_REQUIRED.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const user = await requirePermission(event, PERMISSIONS.ROUTES_SHOW)

  const parsed = RouteShowSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid route search request')
  }

  const db = useDatabase()
  const creds = await getDeviceCredentials(db, event)
  if (!creds) {
    throw apiError(400, 'DEVICE_CREDENTIALS_REQUIRED', 'Enter your device credentials to search')
  }

  const ctx = await buildAuditContext(db, event, user)
  return ok(await routeShow(db, ctx, parsed.data, creds))
})
