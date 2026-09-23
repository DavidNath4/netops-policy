import type { H3Event } from 'h3'
import { getRequestHeader, getRequestIP } from 'h3'

import type { Database } from '~~/database'
import type { UserRow } from '../repositories/user.repository'
import { findWithRoleById } from '../repositories/user.repository'

/**
 * Actor + request context captured for an audit log. `username`/`userRole` are
 * SNAPSHOTS taken at action time so the audit trail survives later user/role
 * changes.
 */
export interface AuditContext {
  userId: string | null
  username: string | null
  userRole: string | null
  sourceIp: string | null
  userAgent: string | null
}

/** Build the audit context for an authenticated actor performing an operation. */
export async function buildAuditContext(
  db: Database,
  event: H3Event,
  user: UserRow,
): Promise<AuditContext> {
  const withRole = await findWithRoleById(db, user.userId)
  return {
    userId: user.userId,
    // Username snapshot: prefer the AD username, fall back to email.
    username: user.username ?? user.email,
    userRole: withRole?.roleCode ?? null,
    sourceIp: getRequestIP(event)?.slice(0, 64) ?? null,
    userAgent: getRequestHeader(event, 'user-agent')?.slice(0, 512) ?? null,
  }
}
