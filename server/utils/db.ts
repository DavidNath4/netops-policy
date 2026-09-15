import { createDatabase } from '~~/database'
import type { Database } from '~~/database'
import { loadEnv } from './config'

/**
 * Shared database handle for request handlers.
 *
 * The connection pool is created once per server process (lazily, on first use)
 * and reused across requests. The startup plugin only does a throwaway
 * connectivity check; this is the pool the app actually queries through.
 */

let cached: Database | null = null

export function useDatabase(): Database {
  if (!cached) {
    cached = createDatabase(loadEnv().DATABASE_URL).db
  }
  return cached
}
