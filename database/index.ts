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

/**
 * A database handle OR an open transaction. The callback passed to
 * `db.transaction(...)` receives a `tx` that lacks `$client`, so repository and
 * service functions that must run either standalone or inside a transaction
 * should accept this wider type instead of `Database`.
 */
export type DbOrTx = Database | Parameters<Parameters<Database['transaction']>[0]>[0]

export { schema }
