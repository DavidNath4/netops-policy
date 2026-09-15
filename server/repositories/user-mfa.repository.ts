import { eq } from 'drizzle-orm'

import type { Database } from '~~/database'
import { userMfa } from '~~/database/schema/user-mfa'

/**
 * Data-access layer for the `user_mfa` table.
 *
 * Stores one TOTP enrollment per user (unique on user_id). The secret is
 * persisted already encrypted by the caller (mfa.service). Repositories never
 * encrypt/decrypt or validate codes — they only read and write rows.
 */

export type UserMfaRow = typeof userMfa.$inferSelect

/** Columns required to create an MFA enrollment. `secretEncrypted` is ciphertext. */
export interface InsertUserMfa {
  userId: string
  secretEncrypted: string
}

export function findByUserId(db: Database, userId: string): Promise<UserMfaRow | undefined> {
  return db.query.userMfa.findFirst({ where: eq(userMfa.userId, userId) })
}

export async function create(db: Database, input: InsertUserMfa): Promise<UserMfaRow> {
  const [row] = await db
    .insert(userMfa)
    .values({
      userId: input.userId,
      secretEncrypted: input.secretEncrypted,
      mfaType: 'TOTP',
      isEnabled: false,
    })
    .returning()

  if (!row) {
    throw new Error('Failed to create MFA enrollment: no row returned from insert')
  }

  return row
}

/** Mark an existing enrollment as enabled once the first code is verified. */
export async function enable(db: Database, userId: string): Promise<void> {
  await db
    .update(userMfa)
    .set({ isEnabled: true, verifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(userMfa.userId, userId))
}

export async function deleteByUserId(db: Database, userId: string): Promise<void> {
  await db.delete(userMfa).where(eq(userMfa.userId, userId))
}
