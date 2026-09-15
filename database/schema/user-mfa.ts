import {
  boolean,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { users } from './users'

export const mfaTypeEnum = pgEnum('mfa_type', ['TOTP'])

export const userMfa = pgTable(
  'user_mfa',
  {
    mfaId: uuid('mfa_id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    mfaType: mfaTypeEnum('mfa_type').notNull().default('TOTP'),
    secretEncrypted: text('secret_encrypted').notNull(),
    isEnabled: boolean('is_enabled').notNull().default(false),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    uniqueIndex('user_mfa_user_id_uidx').on(table.userId),
  ],
)
