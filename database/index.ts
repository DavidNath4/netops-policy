import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

/**
 * PostgreSQL connection (postgres.js driver).
 *
 * The app NEVER provisions or auto-migrates the database. This factory only
 * opens a connection pool against an existing PostgreSQL instance described by
 * DATABASE_URL.
 */
export function createDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  })

  const db = drizzle(client, { schema })

  return { db, client }
}

export type Database = ReturnType<typeof createDatabase>['db']
export { schema }
