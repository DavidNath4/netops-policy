import { z } from 'zod'

// Second authentication factor: a 6-digit TOTP code (digits only).
export const VerifyMfaSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[0-9]{6}$/, 'Code must be exactly 6 digits'),
})

export type VerifyMfaInput = z.infer<typeof VerifyMfaSchema>

// Optional human-friendly label when enrolling a new device from the profile.
export const AddMfaDeviceSchema = z.object({
  label: z.string().trim().min(1).max(60).optional(),
})

export type AddMfaDeviceInput = z.infer<typeof AddMfaDeviceSchema>

// Confirm a newly-enrolled device: identify the pending device + its first code.
export const VerifyMfaDeviceSchema = z.object({
  mfaId: z.string().uuid(),
  code: z
    .string()
    .trim()
    .regex(/^[0-9]{6}$/, 'Code must be exactly 6 digits'),
})

export type VerifyMfaDeviceInput = z.infer<typeof VerifyMfaDeviceSchema>

// A device as shown in the profile. Never carries the secret.
export interface MfaDeviceResponse {
  mfaId: string
  label: string
  mfaType: 'TOTP'
  isEnabled: boolean
  verifiedAt: string | null
  createdAt: string
}

// Max TOTP devices a single user may enrol.
export const MFA_DEVICE_LIMIT = 2
