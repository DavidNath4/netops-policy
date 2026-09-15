import {
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

/**
 * Master role catalog for data-driven RBAC.
 *
 * Roles are data, never hardcoded in authorization logic. A role is retired by
 * setting `is_active = false` (never granting its permissions), not by deletion
 * — and it cannot be deleted while any user still references it (see the
 * `users.role_id` FK which uses ON DELETE RESTRICT).
 *
 * Initial rows (seeded): ADMINISTRATOR, L2_ENGINEER, NOC.
 */
export const roles = pgTable(
  'roles',
  {
    roleId: uuid('role_id').defaultRandom().primaryKey(),
    roleCode: varchar('role_code', { length: 50 }).notNull(),
    roleName: varchar('role_name', { length: 100 }).notNull(),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    uniqueIndex('roles_role_code_uidx').on(table.roleCode),
  ],
)
