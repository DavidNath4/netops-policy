import {
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

import { users } from './users'

export const mfaTypeEnum = pgEnum('mfa_type', ['TOTP'])

// A user may enrol up to TWO TOTP devices (enforced in the service layer, since
// Postgres can't express "at most 2 rows" with a constraint). Each device is a
// separate row addressable by `mfaId`; there is intentionally NO unique index
// on `user_id` — that would cap the user at a single device.
export const userMfa = pgTable(
  'user_mfa',
  {
    mfaId: uuid('mfa_id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    mfaType: mfaTypeEnum('mfa_type').notNull().default('TOTP'),
    // Human-friendly device name shown in the profile (e.g. "Authenticator 1").
    label: text('label').notNull().default('Authenticator'),
    secretEncrypted: text('secret_encrypted').notNull(),
    isEnabled: boolean('is_enabled').notNull().default(false),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index('user_mfa_user_id_idx').on(table.userId),
  ],
)
