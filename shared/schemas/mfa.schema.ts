import { z } from 'zod'

// Second authentication factor: a 6-digit TOTP code (digits only).
export const VerifyMfaSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[0-9]{6}$/, 'Code must be exactly 6 digits'),
})

export type VerifyMfaInput = z.infer<typeof VerifyMfaSchema>
