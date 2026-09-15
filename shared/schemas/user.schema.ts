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
