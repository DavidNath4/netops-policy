import { EnvSchema } from '../utils/config'
import { createDatabase } from '../../database'

/**
 * Nitro startup plugin.
 *
 * 1. Validates environment variables (fail-fast on misconfiguration).
 * 2. Opens the PostgreSQL connection and runs a lightweight 'SELECT 1' to
 *    confirm the database is reachable when the app boots.
 *
 * No migrations, no schema provisioning — connection check only.
 */
export default defineNitroPlugin(async () => {
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    console.error(`[env] Invalid environment configuration:`)
    console.error(parsed.error.flatten().fieldErrors)
    throw new Error('Invalid environment configuration - see errors above.')
  }

  const { db, client } = createDatabase(parsed.data.DATABASE_URL)

  try {
    await client`select 1`
    console.log('[db] Connected to PostgreSQL successfully.')
  }
  catch (err) {
    console.error('[db] Failed to connect to PostgreSQL:')
    console.error(err instanceof Error ? err.message : err)
    throw new Error('Database connection failed at startup - see error above.')
  }
  finally {
    await client.end()
  }

  // Keep the factory reachable for future request handlers.
  void db
})
