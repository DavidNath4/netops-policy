import { and, asc, eq } from 'drizzle-orm'

import type { Database } from '~~/database'
import { userMfa } from '~~/database/schema/user-mfa'

/**
 * Data-access layer for the `user_mfa` table.
 *
 * A user may enrol up to two TOTP devices; each is a row addressable by
 * `mfaId`. The "max 2" rule lives in the service layer. Secrets are persisted
 * already encrypted by the caller (mfa.service) — repositories never
 * encrypt/decrypt or validate codes, they only read and write rows.
 */

export type UserMfaRow = typeof userMfa.$inferSelect

/** Columns required to create an MFA enrollment. `secretEncrypted` is ciphertext. */
export interface InsertUserMfa {
  userId: string
  secretEncrypted: string
  label?: string
}

/** All devices for a user, oldest first (stable order for the profile list). */
export function listByUserId(db: Database, userId: string): Promise<UserMfaRow[]> {
  return db.query.userMfa.findMany({
    where: eq(userMfa.userId, userId),
    orderBy: [asc(userMfa.createdAt)],
  })
}

/**
 * The first enrollment for a user (used by the single-device login/setup flow
 * that predates multi-device). Prefer the mfaId-keyed helpers for new code.
 */
export function findByUserId(db: Database, userId: string): Promise<UserMfaRow | undefined> {
  return db.query.userMfa.findFirst({ where: eq(userMfa.userId, userId) })
}

/** A specific device, scoped to its owner so one user can't touch another's row. */
export function findByMfaId(
  db: Database,
  userId: string,
  mfaId: string,
): Promise<UserMfaRow | undefined> {
  return db.query.userMfa.findFirst({
    where: and(eq(userMfa.mfaId, mfaId), eq(userMfa.userId, userId)),
  })
}

/** Count a user's confirmed (enabled) devices — used to enforce min/max rules. */
export async function countEnabledByUserId(db: Database, userId: string): Promise<number> {
  const rows = await db.query.userMfa.findMany({
    columns: { mfaId: true },
    where: and(eq(userMfa.userId, userId), eq(userMfa.isEnabled, true)),
  })
  return rows.length
}

export async function create(db: Database, input: InsertUserMfa): Promise<UserMfaRow> {
  const [row] = await db
    .insert(userMfa)
    .values({
      userId: input.userId,
      secretEncrypted: input.secretEncrypted,
      mfaType: 'TOTP',
      isEnabled: false,
      ...(input.label ? { label: input.label } : {}),
    })
    .returning()

  if (!row) {
    throw new Error('Failed to create MFA enrollment: no row returned from insert')
  }

  return row
}

/** Mark the user's (single) enrollment enabled — legacy first-setup path. */
export async function enable(db: Database, userId: string): Promise<void> {
  await db
    .update(userMfa)
    .set({ isEnabled: true, verifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(userMfa.userId, userId))
}

/** Mark one specific device enabled once its first code verifies. */
export async function enableByMfaId(db: Database, userId: string, mfaId: string): Promise<void> {
  await db
    .update(userMfa)
    .set({ isEnabled: true, verifiedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(userMfa.mfaId, mfaId), eq(userMfa.userId, userId)))
}

/** Delete all devices for a user (legacy re-enroll path). */
export async function deleteByUserId(db: Database, userId: string): Promise<void> {
  await db.delete(userMfa).where(eq(userMfa.userId, userId))
}

/** Delete one device, scoped to its owner. */
export async function deleteByMfaId(db: Database, userId: string, mfaId: string): Promise<void> {
  await db.delete(userMfa).where(and(eq(userMfa.mfaId, mfaId), eq(userMfa.userId, userId)))
}

/** Remove any pending (unconfirmed) enrollments for a user before starting a new add. */
export async function deletePendingByUserId(db: Database, userId: string): Promise<void> {
  await db.delete(userMfa).where(and(eq(userMfa.userId, userId), eq(userMfa.isEnabled, false)))
}
