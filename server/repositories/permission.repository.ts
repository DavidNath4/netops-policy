import { and, eq } from 'drizzle-orm'

import type { Database } from '~~/database'
import { users } from '~~/database/schema/users'
import { roles } from '~~/database/schema/roles'
import { rolesPermissions } from '~~/database/schema/roles-permissions'
import { permissions } from '~~/database/schema/permissions'

/**
 * Data access for RBAC permission resolution.
 *
 * A user's effective permissions are the permission codes reachable from their
 * (single) active role via the mapping table, counting only active permissions.
 * A user with `role_id = null`, an inactive role, or no mapped permissions
 * resolves to an empty list.
 */

/** Resolve the distinct active permission codes granted to a user. */
export async function findEffectivePermissionCodes(
  db: Database,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ code: permissions.permissionCode })
    .from(users)
    .innerJoin(roles, and(eq(roles.roleId, users.roleId), eq(roles.isActive, true)))
    .innerJoin(rolesPermissions, eq(rolesPermissions.roleId, roles.roleId))
    .innerJoin(
      permissions,
      and(
        eq(permissions.permissionId, rolesPermissions.permissionId),
        eq(permissions.isActive, true),
      ),
    )
    .where(eq(users.userId, userId))

  // De-duplicate defensively (a single role can't map a permission twice due to
  // the unique constraint, but keep this robust).
  return [...new Set(rows.map(r => r.code))]
}
