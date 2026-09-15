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
 * Permission catalog: each capability is a `feature` + `action` pair, referenced
 * in code by `permission_code` (= `<FEATURE>_<ACTION>`).
 *
 * A permission is disabled by setting `is_active = false` (it then grants
 * nothing even if still mapped to a role).
 *
 * Initial rows (seeded):
 *   ACL_POLICIES:  SHOW, ADD, DELETE
 *   ROUTES:        SHOW, ADD, DELETE
 *   ADMINISTRATION: SHOW, MANAGE
 */
export const permissions = pgTable(
  'permissions',
  {
    permissionId: uuid('permission_id').defaultRandom().primaryKey(),
    permissionCode: varchar('permission_code', { length: 100 }).notNull(),
    feature: varchar('feature', { length: 50 }).notNull(),
    action: varchar('action', { length: 30 }).notNull(),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    uniqueIndex('permissions_permission_code_uidx').on(table.permissionCode),
    uniqueIndex('permissions_feature_action_uidx').on(table.feature, table.action),
  ],
)
