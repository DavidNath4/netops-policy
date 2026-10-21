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
 * POST /api/route/show — show-all route listing via n8n. Requires ROUTES_SHOW.
 * route/show returns the full route table and the client filters it. The body is
 * optional and may carry per-request device credentials: the Route Add/Delete
 * "Generate" pre-check sends the credentials typed on that page, so the lookup
 * runs as that engineer. When they are absent the server falls back to the
 * caller's Device Session Credentials; if neither is available it returns
 * DEVICE_CREDENTIALS_REQUIRED.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const user = await requirePermission(event, PERMISSIONS.ROUTES_SHOW)

  const parsed = RouteShowSchema.safeParse((await readBody(event).catch(() => ({}))) ?? {})
  if (!parsed.success) {
    throw apiError(400, 'VALIDATION_ERROR', 'Invalid route show request')
  }

  const db = useDatabase()
  // Prefer the per-request credentials typed on the calling page; fall back to
  // the Device Session Credentials for the routes list page (no credential
  // inputs there).
  const { execUsername, execPassword } = parsed.data
  const creds = execUsername && execPassword
    ? { username: execUsername, password: execPassword }
    : await getDeviceCredentials(db, event)
  if (!creds) {
    throw apiError(400, 'DEVICE_CREDENTIALS_REQUIRED', 'Enter your device credentials to load routes')
  }

  const ctx = await buildAuditContext(db, event, user)
  return ok(await routeShow(db, ctx, creds))
})
