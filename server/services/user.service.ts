import type { Database } from '~~/database'
import type {
  AdminChangeRoleInput,
  AdminCreateUserInput,
  AdminResetPasswordInput,
  AdminUpdateUserInput,
  AdminUserResponse,
  RoleOption,
} from '#shared/schemas/user.schema'

import * as userRepo from '../repositories/user.repository'
import * as roleRepo from '../repositories/role.repository'
import { hashPassword } from './password.service'

/**
 * Administration user-management orchestration.
 *
 * Roles are data: a role is referenced by its code, resolved to an id here.
 * Nothing hardcodes role identifiers in logic. Responses never carry secrets.
 */

/** Distinguishable errors so handlers map to the right HTTP status/code. */
export class UserNotFoundError extends Error {
  constructor() {
    super('User not found')
    this.name = 'UserNotFoundError'
  }
}

export class RoleNotFoundError extends Error {
  constructor() {
    super('Role not found')
    this.name = 'RoleNotFoundError'
  }
}

export class EmailTakenError extends Error {
  constructor() {
    super('Email is already in use')
    this.name = 'EmailTakenError'
  }
}

function toAdminUserResponse(row: userRepo.UserWithRole): AdminUserResponse {
  return {
    userId: row.userId,
    email: row.email,
    displayName: row.displayName,
    roleCode: row.roleCode,
    roleName: row.roleName,
    isActive: row.isActive,
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** List the active roles as {roleCode, roleName} options for the UI. */
export async function listRoleOptions(db: Database): Promise<RoleOption[]> {
  const rows = await roleRepo.listActive(db)
  return rows.map(r => ({ roleCode: r.roleCode, roleName: r.roleName }))
}

export async function listUsers(
  db: Database,
  opts: { page: number, limit: number, search?: string },
): Promise<{ items: AdminUserResponse[], total: number, page: number, limit: number }> {
  const { items, total } = await userRepo.listWithRole(db, opts)
  return { items: items.map(toAdminUserResponse), total, page: opts.page, limit: opts.limit }
}

export async function createUser(
  db: Database,
  input: AdminCreateUserInput,
): Promise<AdminUserResponse> {
  if (await userRepo.existsByEmail(db, input.email)) {
    throw new EmailTakenError()
  }
  const role = await roleRepo.findByCode(db, input.roleCode)
  if (!role) {
    throw new RoleNotFoundError()
  }

  const passwordHash = await hashPassword(input.password)
  const created = await userRepo.createLocalUserWithRole(db, {
    email: input.email,
    displayName: input.displayName,
    passwordHash,
    roleId: role.roleId,
  })

  const withRole = await userRepo.findWithRoleById(db, created.userId)
  // Freshly created — the join always resolves.
  return toAdminUserResponse(withRole!)
}

export async function updateUserBasic(
  db: Database,
  userId: string,
  input: AdminUpdateUserInput,
): Promise<AdminUserResponse> {
  const existing = await userRepo.findById(db, userId)
  if (!existing) throw new UserNotFoundError()

  await userRepo.updateDisplayName(db, userId, input.displayName)
  return toAdminUserResponse((await userRepo.findWithRoleById(db, userId))!)
}

export async function changeUserRole(
  db: Database,
  userId: string,
  input: AdminChangeRoleInput,
): Promise<AdminUserResponse> {
  const existing = await userRepo.findById(db, userId)
  if (!existing) throw new UserNotFoundError()

  const role = await roleRepo.findByCode(db, input.roleCode)
  if (!role) throw new RoleNotFoundError()

  await userRepo.setRoleId(db, userId, role.roleId)
  return toAdminUserResponse((await userRepo.findWithRoleById(db, userId))!)
}

export async function setUserStatus(
  db: Database,
  userId: string,
  isActive: boolean,
): Promise<AdminUserResponse> {
  const existing = await userRepo.findById(db, userId)
  if (!existing) throw new UserNotFoundError()

  await userRepo.setActive(db, userId, isActive)
  return toAdminUserResponse((await userRepo.findWithRoleById(db, userId))!)
}

export async function resetUserPassword(
  db: Database,
  userId: string,
  input: AdminResetPasswordInput,
): Promise<void> {
  const existing = await userRepo.findById(db, userId)
  if (!existing) throw new UserNotFoundError()

  const passwordHash = await hashPassword(input.password)
  await userRepo.setPasswordHash(db, userId, passwordHash)
}
