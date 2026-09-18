import { z } from 'zod'

// First authentication factor: identifier + password.
//
// The identifier is intentionally NOT constrained to an email, because AD users
// may log in with either their email/UPN (e.g. jdoe@mov.co.id) or their
// sAMAccountName (e.g. jdoe). Provider routing + the provider itself decide
// validity: LOCAL looks the identifier up as an email; AD searches the directory
// for a matching account. MFA (second factor) is validated in mfa.schema.ts.
export const LoginSchema = z.object({
  identifier: z
    .string()
    .trim()
    .min(1, 'Username or email is required')
    .max(255, 'Identifier must be at most 255 characters'),
  password: z.string().min(1, 'Password is required'),
})

export type LoginInput = z.infer<typeof LoginSchema>
