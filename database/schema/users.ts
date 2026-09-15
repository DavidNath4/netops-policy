import {
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

import { roles } from './roles'

export const authProviderEnum = pgEnum('auth_provider', ['LOCAL', 'AD'])

export const users = pgTable(
  'users',
  {
    userId: uuid('user_id').defaultRandom().primaryKey(),
    email: varchar('email', { length: 255 }).notNull(),
    displayName: varchar('display_name', { length: 150 }).notNull(),
    passwordHash: text('password_hash'),
    authProvider: authProviderEnum('auth_provider').notNull().default('LOCAL'),
    externalId: varchar('external_id', { length: 255 }),
    // One role per user (data-driven RBAC). Nullable = no feature permissions.
    // RESTRICT: a role in use cannot be deleted (retire it via roles.is_active).
    roleId: uuid('role_id').references(() => roles.roleId, { onDelete: 'restrict' }),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    uniqueIndex('users_email_uidx').on(table.email),
    uniqueIndex('users_external_id_uidx').on(table.externalId),
    index('users_role_id_idx').on(table.roleId),
  ],
)
