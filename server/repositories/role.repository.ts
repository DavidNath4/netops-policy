import { asc, eq } from 'drizzle-orm'

import type { Database } from '~~/database'
import { roles } from '~~/database/schema/roles'

/**
 * Data access for the `roles` table (read-only in this phase — roles are
 * provisioned via seed/data, not created through the UI).
 */

export type RoleRow = typeof roles.$inferSelect

/** All active roles, ordered by name — used for the role dropdown. */
export function listActive(db: Database): Promise<RoleRow[]> {
  return db.query.roles.findMany({
    where: eq(roles.isActive, true),
    orderBy: [asc(roles.roleName)],
  })
}

/** Find a role by its code (any active state); undefined when unknown. */
export function findByCode(db: Database, roleCode: string): Promise<RoleRow | undefined> {
  return db.query.roles.findFirst({ where: eq(roles.roleCode, roleCode) })
}
