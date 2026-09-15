import { eq, sql } from 'drizzle-orm'

import type { Database } from '~~/database'
import { users } from '~~/database/schema/users'

/**
 * Data-access layer for the `users` table.
 *
 * Repositories only talk to the database. They contain no HTTP concerns, no
 * password hashing/verification, and never validate request input — callers
 * (services) are responsible for that. Rows are returned as-is; stripping
 * sensitive fields (passwordHash) for responses happens in the service layer.
 */

export type UserRow = typeof users.$inferSelect

/** Columns required to insert a LOCAL user. Server-controlled only. */
export interface InsertLocalUser {
  email: string
  displayName: string
  passwordHash: string
}

export function findById(db: Database, userId: string): Promise<UserRow | undefined> {
  return db.query.users.findFirst({ where: eq(users.userId, userId) })
}

export function findByEmail(db: Database, email: string): Promise<UserRow | undefined> {
  return db.query.users.findFirst({ where: eq(users.email, email) })
}

export async function createLocalUser(db: Database, input: InsertLocalUser): Promise<UserRow> {
  const [row] = await db
    .insert(users)
    .values({
      email: input.email,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
      authProvider: 'LOCAL',
    })
    .returning()

  // .returning() always yields the inserted row; guard for the type system.
  if (!row) {
    throw new Error('Failed to create user: no row returned from insert')
  }

  return row
}

export async function updateLastLogin(db: Database, userId: string): Promise<void> {
  await db
    .update(users)
    .set({ lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(users.userId, userId))
}

export async function existsByEmail(db: Database, email: string): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)

  return row !== undefined
}
