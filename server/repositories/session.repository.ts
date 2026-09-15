import { eq, lt } from 'drizzle-orm'

import type { Database } from '~~/database'
import { sessions } from '~~/database/schema/sessions'

/**
 * Data-access layer for the `sessions` table.
 *
 * Repositories only touch the database. They never generate/hash tokens, read
 * cookies, or decide whether a session is valid — the session service owns that.
 * Only the SHA-256 token hash is ever passed in; the raw token never reaches
 * this layer.
 */

export type SessionRow = typeof sessions.$inferSelect

export interface InsertSession {
  userId: string
  tokenHash: string
  expiresAt: Date
  sourceIp?: string | null
  userAgent?: string | null
}

export async function createSession(db: Database, input: InsertSession): Promise<SessionRow> {
  const [row] = await db
    .insert(sessions)
    .values({
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      sourceIp: input.sourceIp ?? null,
      userAgent: input.userAgent ?? null,
    })
    .returning()

  if (!row) {
    throw new Error('Failed to create session: no row returned from insert')
  }

  return row
}

export function findByTokenHash(db: Database, tokenHash: string): Promise<SessionRow | undefined> {
  return db.query.sessions.findFirst({ where: eq(sessions.tokenHash, tokenHash) })
}

export async function deleteByTokenHash(db: Database, tokenHash: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash))
}

export async function deleteAllByUserId(db: Database, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId))
}

export async function updateLastUsed(db: Database, tokenHash: string, at: Date): Promise<void> {
  await db.update(sessions).set({ lastUsedAt: at }).where(eq(sessions.tokenHash, tokenHash))
}

/** Housekeeping: remove sessions whose expiry is already in the past. */
export async function deleteExpiredSessions(db: Database, now: Date = new Date()): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, now))
}
