// Client-facing type aliases used by pages/composables. Where a shared Zod
// schema is the source of truth, we re-export its inferred type here so the
// frontend imports stay stable.

import type { UserResponse } from '#shared/schemas/user.schema'

export type { AclAction, Protocol } from '#shared/schemas/network.schema'
export type { AdminUserResponse, RoleOption, UserResponse } from '#shared/schemas/user.schema'

/** Current authenticated identity + resolved permissions (GET /api/auth/me). */
export interface AuthMe {
  user: UserResponse
  permissions: string[]
}

/** Login form credentials (first factor). */
export interface LoginCredentials {
  identifier: string
  password: string
}

/** Common list query params. */
export interface ListParams {
  page?: number
  limit?: number
  search?: string
  status?: string
}

/** Paginated list envelope. */
export interface Paginated<T> {
  items: T[]
  total: number
  page: number
  limit: number
}

/** Administration create-user input. */
export interface CreateUserInput {
  email: string
  displayName: string
  password: string
  roleCode: string
}

/** Administration update-user input. */
export interface UpdateUserInput {
  displayName: string
}
