import { z } from 'zod'

/**
 * Environment configuration schema (server-only).
 *
 * Validated once at Nitro startup by server/plugins/validate-env.ts so
 * misconfiguration fails fast rather than at the first query.
 *
 * SECURITY: none of these values may be exposed via runtimeConfig.public.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid URL'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  // AES-256-GCM key for encrypting TOTP secrets at rest.
  // 32 bytes encoded as 64 hex characters. Never stored in the database,
  // never sent to the client.
  MFA_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'MFA_ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),
  // Authenticated session lifetime, in hours. Drives both the DB `expires_at`
  // and the session cookie MaxAge. Server-only.
  SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .positive('SESSION_TTL_HOURS must be a positive integer')
    .default(8),
  // Lifetime of the short-lived pre-auth MFA challenge cookie, in minutes.
  // After this window the user must log in again. Server-only.
  MFA_CHALLENGE_TTL_MINUTES: z.coerce
    .number()
    .int()
    .positive('MFA_CHALLENGE_TTL_MINUTES must be a positive integer')
    .default(5),

  // -------------------------------------------------------------------------
  // Active Directory (AD / LDAP) authentication. See .kiro/specs/ad-authentication.
  // AD_URL / AD_BASE_DN / AD_BIND_DN / AD_BIND_PASSWORD are required only when
  // AD_ENABLED is true (enforced by the refinement below).
  // -------------------------------------------------------------------------
  AD_ENABLED: z.coerce.boolean().default(false),
  // Enables LOCAL (email + password) logins. true in dev; false in AD-only prod.
  AUTH_LOCAL_ENABLED: z.coerce.boolean().default(true),
  AD_URL: z.string().optional(),
  AD_BASE_DN: z.string().optional(),
  AD_BIND_DN: z.string().optional(),
  AD_BIND_PASSWORD: z.string().optional(),
  // Bounded connect/operation timeout so an unresponsive directory fails fast.
  AD_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive('AD_TIMEOUT_MS must be a positive integer')
    .default(5000),
})
  .refine(
    env => !env.AD_ENABLED || (env.AD_URL && env.AD_BASE_DN && env.AD_BIND_DN && env.AD_BIND_PASSWORD),
    {
      message:
        'When AD_ENABLED is true, AD_URL, AD_BASE_DN, AD_BIND_DN and AD_BIND_PASSWORD are all required',
      path: ['AD_ENABLED'],
    },
  )

export type Env = z.infer<typeof EnvSchema>

/**
 * Parse and validate process.env. Throws a ZodError with readable messages
 * when configuration is invalid.
 */
export function loadEnv(): Env {
  return EnvSchema.parse(process.env)
}
