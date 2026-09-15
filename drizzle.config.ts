import { defineConfig } from 'drizzle-kit'

// drizzle-kit reads .env automatically. Used only for explicit
// 'npm run db:generate' / 'npm run db:migrate' — never at app runtime.
export default defineConfig({
  schema: './database/schema/index.ts',
  out: './database/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
})
