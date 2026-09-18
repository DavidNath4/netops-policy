import { count, desc, eq, ilike, or, sql } from 'drizzle-orm'

import type { Database } from '~~/database'
import { users } from '~~/database/schema/users'
import { roles } from '~~/database/schema/roles'

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

/** Find an AD-provisioned user by its immutable directory id (objectGUID). */
export function findByExternalId(db: Database, externalId: string): Promise<UserRow | undefined> {
  return db.query.users.findFirst({ where: eq(users.externalId, externalId) })
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

/** Columns required to just-in-time provision an AD user. Server-controlled only. */
export interface InsertAdUser {
  externalId: string
  email: string
  displayName: string
}

/**
 * Create an AD-provisioned user (first login). No password is stored; the role
 * is left null (common access) until an administrator assigns one.
 */
export async function createAdUser(db: Database, input: InsertAdUser): Promise<UserRow> {
  const [row] = await db
    .insert(users)
    .values({
      email: input.email,
      displayName: input.displayName,
      passwordHash: null,
      authProvider: 'AD',
      externalId: input.externalId,
      // roleId left undefined → null (no feature permissions until assigned).
    })
    .returning()

  if (!row) {
    throw new Error('Failed to create AD user: no row returned from insert')
  }

  return row
}

/**
 * Refresh mutable directory-sourced fields for a returning AD user. Never
 * touches externalId, roleId, or isActive.
 */
export async function updateAdProfile(
  db: Database,
  userId: string,
  input: { email: string, displayName: string },
): Promise<void> {
  await db
    .update(users)
    .set({ email: input.email, displayName: input.displayName, updatedAt: new Date() })
    .where(eq(users.userId, userId))
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

// ---------------------------------------------------------------------------
// Administration (user management)
// ---------------------------------------------------------------------------

/** A user row joined with its (optional) role, for the admin list/detail. */
export interface UserWithRole {
  userId: string
  email: string
  displayName: string
  roleCode: string | null
  roleName: string | null
  isActive: boolean
  lastLoginAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** Columns to insert a LOCAL user together with a role. */
export interface InsertLocalUserWithRole extends InsertLocalUser {
  roleId: string
}

/** Paginated user list with the role joined and an optional email/name search. */
export async function listWithRole(
  db: Database,
  opts: { page: number, limit: number, search?: string },
): Promise<{ items: UserWithRole[], total: number }> {
  const search = opts.search?.trim()
  const where = search
    ? or(ilike(users.email, `%${search}%`), ilike(users.displayName, `%${search}%`))
    : undefined

  const [{ value: total } = { value: 0 }] = await db
    .select({ value: count() })
    .from(users)
    .where(where)

  const rows = await db
    .select({
      userId: users.userId,
      email: users.email,
      displayName: users.displayName,
      roleCode: roles.roleCode,
      roleName: roles.roleName,
      isActive: users.isActive,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .leftJoin(roles, eq(roles.roleId, users.roleId))
    .where(where)
    .orderBy(desc(users.createdAt))
    .limit(opts.limit)
    .offset((opts.page - 1) * opts.limit)

  return { items: rows, total }
}

/** One user joined with its role, or undefined. */
export async function findWithRoleById(
  db: Database,
  userId: string,
): Promise<UserWithRole | undefined> {
  const [row] = await db
    .select({
      userId: users.userId,
      email: users.email,
      displayName: users.displayName,
      roleCode: roles.roleCode,
      roleName: roles.roleName,
      isActive: users.isActive,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .leftJoin(roles, eq(roles.roleId, users.roleId))
    .where(eq(users.userId, userId))
    .limit(1)

  return row
}

export async function createLocalUserWithRole(
  db: Database,
  input: InsertLocalUserWithRole,
): Promise<UserRow> {
  const [row] = await db
    .insert(users)
    .values({
      email: input.email,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
      authProvider: 'LOCAL',
      roleId: input.roleId,
    })
    .returning()

  if (!row) {
    throw new Error('Failed to create user: no row returned from insert')
  }
  return row
}

export async function updateDisplayName(
  db: Database,
  userId: string,
  displayName: string,
): Promise<void> {
  await db
    .update(users)
    .set({ displayName, updatedAt: new Date() })
    .where(eq(users.userId, userId))
}

export async function setRoleId(db: Database, userId: string, roleId: string): Promise<void> {
  await db
    .update(users)
    .set({ roleId, updatedAt: new Date() })
    .where(eq(users.userId, userId))
}

export async function setActive(db: Database, userId: string, isActive: boolean): Promise<void> {
  await db
    .update(users)
    .set({ isActive, updatedAt: new Date() })
    .where(eq(users.userId, userId))
}

export async function setPasswordHash(
  db: Database,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.userId, userId))
}
