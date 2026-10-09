import { defineConfig } from 'drizzle-kit'

// drizzle-kit reads .env automatically. Used only for explicit
// 'npm run db:generate' / 'npm run db:migrate' — never at app runtime.
// The connection is assembled from the discrete DB_* parts (raw password,
// percent-encoded here) to match the app's EnvSchema.
const { DB_HOST, DB_PORT = '5432', DB_NAME, DB_USER, DB_PASSWORD } = process.env
const url = `postgres://${encodeURIComponent(DB_USER!)}:${encodeURIComponent(DB_PASSWORD!)}@${DB_HOST}:${DB_PORT}/${DB_NAME}`

export default defineConfig({
  schema: './database/schema/index.ts',
  out: './database/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url,
  },
  verbose: true,
  strict: true,
})
