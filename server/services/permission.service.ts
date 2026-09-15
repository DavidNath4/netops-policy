import type { Database } from '~~/database'
import { findEffectivePermissionCodes } from '../repositories/permission.repository'

/**
 * Permission resolution + checks for data-driven RBAC.
 *
 * Authorization never branches on a role identifier — it only asks whether a
 * resolved permission code is present. Codes are resolved from the database
 * (users → active role → mapping → active permissions).
 */

/** Resolve a user's effective permission codes as a Set for O(1) checks. */
export async function getEffectivePermissions(
  db: Database,
  userId: string,
): Promise<Set<string>> {
  const codes = await findEffectivePermissionCodes(db, userId)
  return new Set(codes)
}

/** True when the resolved permission set contains the required code. */
export function hasPermission(permissionSet: Set<string>, code: string): boolean {
  return permissionSet.has(code)
}
