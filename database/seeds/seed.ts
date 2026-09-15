import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { createDatabase } from '../index'
import { users } from '../schema/users'
import { hashPassword } from '../../server/services/password.service'

/**
 * Development seed: create the first LOCAL user.
 *
 * Run manually with `npm run db:seed` after the migrations are applied. This is
 * NOT run at application startup — the app never provisions data on boot.
 *
 * Idempotent: if the email already exists, it reports so and exits cleanly.
 * The password is read from the environment and is NEVER logged.
 *
 * NOTE: this script runs under plain `tsx`, which does not resolve Nuxt/Nitro
 * path aliases (`~~`, `#shared`). So it uses only relative imports and talks to
 * Drizzle directly instead of going through the alias-using repositories.
 */

// Load .env for standalone execution (Node 20.6+/24 built-in). Nuxt loads env
// itself at dev/build time, but a plain tsx script does not.
try {
  process.loadEnvFile()
}
catch {
  // No .env file present — rely on already-exported environment variables.
}

const SeedEnvSchema = z.object({
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid URL'),
  SEED_USER_EMAIL: z
    .string()
    .trim()
    .toLowerCase()
    .max(255, 'SEED_USER_EMAIL must be at most 255 characters')
    .email('SEED_USER_EMAIL must be a valid email'),
  SEED_USER_DISPLAY_NAME: z
    .string()
    .trim()
    .min(1, 'SEED_USER_DISPLAY_NAME is required')
    .max(150, 'SEED_USER_DISPLAY_NAME must be at most 150 characters'),
  SEED_USER_PASSWORD: z
    .string()
    .min(8, 'SEED_USER_PASSWORD must be at least 8 characters')
    .max(128, 'SEED_USER_PASSWORD must be at most 128 characters'),
})

async function main(): Promise<void> {
  const env = SeedEnvSchema.parse(process.env)

  const { db, client } = createDatabase(env.DATABASE_URL)

  try {
    const existing = await db.query.users.findFirst({
      where: eq(users.email, env.SEED_USER_EMAIL),
    })

    if (existing) {
      console.log('Development user already exists.')
      return
    }

    const passwordHash = await hashPassword(env.SEED_USER_PASSWORD)

    await db.insert(users).values({
      email: env.SEED_USER_EMAIL,
      displayName: env.SEED_USER_DISPLAY_NAME,
      passwordHash,
      authProvider: 'LOCAL',
    })

    console.log('Development user created successfully.')
  }
  finally {
    await client.end()
  }
}

main().catch((err) => {
  // Never print the password; only surface the error message.
  console.error('Seed failed:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
