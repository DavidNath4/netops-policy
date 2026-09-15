import {
  boolean,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

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
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    uniqueIndex('users_email_uidx').on(table.email),
    uniqueIndex('users_external_id_uidx').on(table.externalId),
  ],
)
