import { z } from 'zod'

// Application-level validation for user data (Zod, runtime).
// Drizzle schema is NOT used for request validation.

// Fields a client may send when creating a LOCAL user. Everything else
// (userId, passwordHash, authProvider, externalId, isActive, timestamps,
// lastLoginAt) is server-controlled and must never come from input.
export const CreateLocalUserSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(255, 'Email must be at most 255 characters')
    .email('Invalid email address'),
  displayName: z
    .string()
    .trim()
    .min(1, 'Display name is required')
    .max(150, 'Display name must be at most 150 characters'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters'),
})

export type CreateLocalUserInput = z.infer<typeof CreateLocalUserSchema>

// Safe user shape returned to clients. Never contains passwordHash or secrets.
export const UserResponseSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string(),
  authProvider: z.enum(['LOCAL', 'AD']),
  isActive: z.boolean(),
  lastLoginAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type UserResponse = z.infer<typeof UserResponseSchema>

// ---------------------------------------------------------------------------
// Administration (user management) request schemas.
//
// One role per user, referenced by role_code (ADMINISTRATOR | L2_ENGINEER | NOC
// | future). The server validates that the code maps to an existing active
// role; we don't hardcode the allowed codes here so new roles work without a
// code change.
// ---------------------------------------------------------------------------

const RoleCodeField = z
  .string()
  .trim()
  .min(1, 'Role is required')
  .max(50, 'Role code must be at most 50 characters')

/** Create a LOCAL user with a role (Administration → Add User). */
export const AdminCreateUserSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(255, 'Email must be at most 255 characters')
    .email('Invalid email address'),
  displayName: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(150, 'Name must be at most 150 characters'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters'),
  roleCode: RoleCodeField,
})

export type AdminCreateUserInput = z.infer<typeof AdminCreateUserSchema>

/** Update a user's basic info (name only for now). */
export const AdminUpdateUserSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(150, 'Name must be at most 150 characters'),
})

export type AdminUpdateUserInput = z.infer<typeof AdminUpdateUserSchema>

/** Change a user's single role. */
export const AdminChangeRoleSchema = z.object({
  roleCode: RoleCodeField,
})

export type AdminChangeRoleInput = z.infer<typeof AdminChangeRoleSchema>

/** Enable/disable a user. */
export const AdminSetStatusSchema = z.object({
  isActive: z.boolean(),
})

export type AdminSetStatusInput = z.infer<typeof AdminSetStatusSchema>

/** Reset a user's password to a new value. */
export const AdminResetPasswordSchema = z.object({
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters'),
})

export type AdminResetPasswordInput = z.infer<typeof AdminResetPasswordSchema>

/**
 * Administration user row returned to the client. One role per user; roleCode/
 * roleName are null when the user has no role assigned. Never carries secrets.
 */
export interface AdminUserResponse {
  userId: string
  email: string
  displayName: string
  roleCode: string | null
  roleName: string | null
  isActive: boolean
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

/** A role option for the Administration role dropdown. */
export interface RoleOption {
  roleCode: string
  roleName: string
}
