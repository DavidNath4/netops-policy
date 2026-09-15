import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

import { users } from './users'

/**
 * Server-side authentication sessions.
 *
 * SECURITY: the raw session token is NEVER stored here. Only its SHA-256 hash
 * (`token_hash`) is persisted; the raw token lives solely in the `netops_session`
 * HttpOnly cookie. A row exists only after MFA has succeeded.
 */
export const sessions = pgTable(
  'sessions',
  {
    sessionId: uuid('session_id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    sourceIp: varchar('source_ip', { length: 64 }),
    userAgent: varchar('user_agent', { length: 512 }),
  },
  table => [
    uniqueIndex('sessions_token_hash_uidx').on(table.tokenHash),
    index('sessions_user_id_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
)
