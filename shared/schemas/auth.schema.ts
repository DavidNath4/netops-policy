import { z } from 'zod'

// First authentication factor: email + password only.
// MFA (second factor) is validated separately in mfa.schema.ts.
export const LoginSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(255, 'Email must be at most 255 characters')
    .email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
})

export type LoginInput = z.infer<typeof LoginSchema>
