import {
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { permissions } from './permissions'
import { roles } from './roles'

/**
 * Role → Permission mapping (many-to-many). A role's access is the set of
 * permissions granted here. Both FKs cascade on delete so removing a role or a
 * permission cleans up its mapping rows (it never touches users).
 *
 * Unique on (role_id, permission_id) prevents duplicate grants.
 */
export const rolesPermissions = pgTable(
  'roles_permissions',
  {
    rolePermissionId: uuid('role_permission_id').defaultRandom().primaryKey(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.roleId, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.permissionId, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    uniqueIndex('roles_permissions_role_perm_uidx').on(table.roleId, table.permissionId),
  ],
)
