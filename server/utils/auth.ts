import type { H3Event } from 'h3'
import { getRequestHeader, getRequestHost } from 'h3'

import type { UserRow } from '../repositories/user.repository'
import { toUserResponse } from '../services/auth.service'
import { validateSession } from '../services/session.service'
import { getEffectivePermissions, hasPermission } from '../services/permission.service'
import { useDatabase } from './db'
import { apiError } from './envelope'
import type { UserResponse } from '#shared/schemas/user.schema'

/**
 * Request-level authentication helpers.
 *
 * Centralizes session resolution so no endpoint re-implements cookie → session
 * → user lookup. `getAuthenticatedUser` returns the DB row (or null);
 * `requireAuthenticatedUser` throws 401 when unauthenticated. Handlers that need
 * a client-safe shape use `toUserResponse`.
 */

export async function getAuthenticatedUser(event: H3Event): Promise<UserRow | null> {
  return validateSession(useDatabase(), event)
}

export async function requireAuthenticatedUser(event: H3Event): Promise<UserRow> {
  const user = await getAuthenticatedUser(event)
  if (!user) {
    throw apiError(401, 'UNAUTHENTICATED', 'Authentication required')
  }
  return user
}

/**
 * Authorize a request by data-driven permission (RBAC).
 *
 * Rejects with 401 when unauthenticated and 403 when the authenticated user's
 * resolved permissions do not include `code`. Never branches on a role
 * identifier — the decision is purely permission-based. Returns the user row so
 * handlers can proceed without re-fetching.
 *
 * Example: `const user = await requirePermission(event, PERMISSIONS.ACL_POLICIES_ADD)`
 */
export async function requirePermission(event: H3Event, code: string): Promise<UserRow> {
  const user = await requireAuthenticatedUser(event)
  const permissionSet = await getEffectivePermissions(useDatabase(), user.userId)
  if (!hasPermission(permissionSet, code)) {
    throw apiError(403, 'FORBIDDEN', 'You do not have permission to perform this action')
  }
  return user
}

/** Convenience: authenticated user already mapped to the safe response shape. */
export async function requireAuthenticatedUserResponse(event: H3Event): Promise<UserResponse> {
  return toUserResponse(await requireAuthenticatedUser(event))
}

/**
 * Same-origin guard for cookie-authenticated mutations (defense-in-depth on top
 * of SameSite=Lax). Rejects cross-origin requests whose Origin host doesn't
 * match the request host. When no Origin header is present (e.g. same-origin
 * navigations or non-browser clients in dev), the request is allowed.
 */
export function assertSameOrigin(event: H3Event): void {
  const origin = getRequestHeader(event, 'origin')
  if (!origin) {
    return
  }

  let originHost: string
  try {
    originHost = new URL(origin).host
  }
  catch {
    throw apiError(403, 'FORBIDDEN_ORIGIN', 'Cross-origin request rejected')
  }

  const host = getRequestHost(event)
  if (originHost !== host) {
    throw apiError(403, 'FORBIDDEN_ORIGIN', 'Cross-origin request rejected')
  }
}
