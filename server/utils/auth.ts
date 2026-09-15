import type { H3Event } from 'h3'
import { getRequestHeader, getRequestHost } from 'h3'

import type { UserRow } from '../repositories/user.repository'
import { toUserResponse } from '../services/auth.service'
import { validateSession } from '../services/session.service'
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
