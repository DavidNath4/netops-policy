import { z } from 'zod'

/**
 * Environment configuration schema (server-only).
 *
 * Validated once at Nitro startup by server/plugins/validate-env.ts so
 * misconfiguration fails fast rather than at the first query.
 *
 * SECURITY: none of these values may be exposed via runtimeConfig.public.
 */
/**
 * Build a connection URL from discrete parts, percent-encoding the user and
 * password so passwords containing URL-special characters (# @ : / etc.) are
 * handled safely. Sysops fill the RAW password in DB_PASSWORD / ITOP_PASSWORD —
 * no manual encoding required.
 */
function buildDbUrl(
  scheme: string,
  user: string,
  password: string,
  host: string,
  port: number,
  database: string,
): string {
  const u = encodeURIComponent(user)
  const p = encodeURIComponent(password)
  return `${scheme}://${u}:${p}@${host}:${port}/${database}`
}

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // -------------------------------------------------------------------------
  // Application database (PostgreSQL). Supplied as discrete parts so the raw
  // password needs no manual URL-encoding; the parts are assembled into
  // DATABASE_URL below (DB_PASSWORD is percent-encoded automatically).
  // -------------------------------------------------------------------------
  DB_HOST: z.string().min(1, 'DB_HOST is required'),
  DB_PORT: z.coerce.number().int().positive('DB_PORT must be a positive integer').default(5432),
  DB_NAME: z.string().min(1, 'DB_NAME is required'),
  DB_USER: z.string().min(1, 'DB_USER is required'),
  DB_PASSWORD: z.string().min(1, 'DB_PASSWORD is required'),

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

  // -------------------------------------------------------------------------
  // n8n integration (ACL/route execution). See .kiro/specs/n8n-integration.
  // The app forwards field payloads to n8n over an authenticated webhook; n8n
  // composes and runs the device command via the SSH jump host. The API key is
  // server-only and must never be exposed via runtimeConfig.public.
  // -------------------------------------------------------------------------
  N8N_BASE_URL: z.string().url('N8N_BASE_URL must be a valid URL'),
  N8N_API_KEY: z.string().min(1, 'N8N_API_KEY is required'),
  // Bounded per-call timeout so an unresponsive n8n fails fast.
  N8N_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive('N8N_TIMEOUT_MS must be a positive integer')
    .default(15000),

  // -------------------------------------------------------------------------
  // iTop (read-only MariaDB) ticket lookup. OPTIONAL — the app boots without it;
  // ticket endpoints return ITOP_UNREACHABLE and the admin Test button reports
  // "not configured" when unset. Supplied as discrete parts (raw password, no
  // manual URL-encoding); assembled into ITOP_DATABASE_URL below. iTop is
  // enabled only when ALL of ITOP_HOST/ITOP_NAME/ITOP_USER/ITOP_PASSWORD are set
  // (enforced by the refinement below). See .kiro/specs/n8n-integration.
  // -------------------------------------------------------------------------
  ITOP_HOST: z.string().optional(),
  ITOP_PORT: z.coerce.number().int().positive('ITOP_PORT must be a positive integer').default(3306),
  ITOP_NAME: z.string().optional(),
  ITOP_USER: z.string().optional(),
  ITOP_PASSWORD: z.string().optional(),
  ITOP_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive('ITOP_TIMEOUT_MS must be a positive integer')
    .default(10000),
})
  .refine(
    env => !env.AD_ENABLED || (env.AD_URL && env.AD_BASE_DN && env.AD_BIND_DN && env.AD_BIND_PASSWORD),
    {
      message:
        'When AD_ENABLED is true, AD_URL, AD_BASE_DN, AD_BIND_DN and AD_BIND_PASSWORD are all required',
      path: ['AD_ENABLED'],
    },
  )
  .refine(
    (env) => {
      // iTop is all-or-nothing: either none of the parts are set (feature off)
      // or the four required parts are all present. Partial config is an error.
      const parts = [env.ITOP_HOST, env.ITOP_NAME, env.ITOP_USER, env.ITOP_PASSWORD]
      const anySet = parts.some(Boolean)
      const allSet = parts.every(Boolean)
      return !anySet || allSet
    },
    {
      message:
        'iTop config is incomplete: set ITOP_HOST, ITOP_NAME, ITOP_USER and ITOP_PASSWORD together, or leave all unset to disable iTop',
      path: ['ITOP_HOST'],
    },
  )
  // Assemble the connection URLs from the discrete parts. Downstream code keeps
  // reading env.DATABASE_URL / env.ITOP_DATABASE_URL unchanged.
  .transform(env => ({
    ...env,
    DATABASE_URL: buildDbUrl('postgres', env.DB_USER, env.DB_PASSWORD, env.DB_HOST, env.DB_PORT, env.DB_NAME),
    ITOP_DATABASE_URL:
      env.ITOP_HOST && env.ITOP_NAME && env.ITOP_USER && env.ITOP_PASSWORD
        ? buildDbUrl('mysql', env.ITOP_USER, env.ITOP_PASSWORD, env.ITOP_HOST, env.ITOP_PORT, env.ITOP_NAME)
        : undefined,
  }))

export type Env = z.infer<typeof EnvSchema>

/**
 * Parse and validate process.env. Throws a ZodError with readable messages
 * when configuration is invalid.
 */
export function loadEnv(): Env {
  return EnvSchema.parse(process.env)
}
