# NetOps Policy Manager

Internal web app for authoring and reviewing network ACL & route policies, with
authenticated, role-based access. Nuxt 4 (Vue 3 + Nitro) · Drizzle ORM ·
PostgreSQL · Tailwind + Nuxt UI. Auth supports LOCAL accounts (email + password)
and Active Directory (LDAP), both behind a NetOps-managed TOTP second factor.

## Prerequisites

- **Node.js 24** (see `.nvmrc`; `nvm use`). Range: `>=22 <25`.
- **PostgreSQL 16** — you provide your own; the app never provisions a database.
  Create an empty database for NetOps before migrating.
- **Network access to the AD server** — only if testing AD login.

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Create your env file, then fill in the required values (see below)
cp .env.example .env

# 3. Apply all migrations to your empty database (schema → latest)
npm run db:migrate

# 4. Seed roles/permissions + the initial LOCAL admin (idempotent)
npm run db:seed

# 5. Run the dev server
npm run dev
```

Log in with `SEED_USER_EMAIL` / `SEED_USER_PASSWORD`, then complete MFA setup
(scan the QR with any TOTP app).

## Environment (`.env`)

`.env` is git-ignored — copy from `.env.example` and fill it in. Startup
validates these and fails fast if any is invalid.

Required:

- `DATABASE_URL` — PostgreSQL connection string.
- `SESSION_SECRET` — random string, min 32 chars.
- `MFA_ENCRYPTION_KEY` — exactly 64 hex chars (32 bytes). Generate:
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `SEED_USER_EMAIL` / `SEED_USER_DISPLAY_NAME` / `SEED_USER_PASSWORD` — initial
  LOCAL admin, used by `db:seed`.

Active Directory (optional — only if testing AD login):

- `AD_ENABLED=true`, keep `AUTH_LOCAL_ENABLED=true` in dev.
- `AD_URL`, `AD_BASE_DN`, `AD_BIND_DN` — directory endpoint / base DN / service
  account (examples are in `.env.example`).
- `AD_BIND_PASSWORD` — fill manually; never commit. Required when `AD_ENABLED=true`.

Leave `AD_ENABLED=false` to run with LOCAL login only.

## Database migrations

The app never auto-migrates on startup — always explicit.

| Command | Purpose | Who runs it |
|---|---|---|
| `npm run db:migrate` | Apply existing migration files to the DB (brings schema to latest). | Everyone, on setup and after pulling new migrations. |
| `npm run db:generate` | Generate a **new** migration from schema changes in `database/schema/`. | Only when you change the schema. Commit the generated file. |

Migration files in `database/migrations/` are committed, so a fresh clone only
needs `db:migrate` (do **not** run `db:generate` during setup).

When changing the schema: edit `database/schema/*.ts` → `db:generate` →
`db:migrate` → commit the new `.sql` + `meta/` files.

## Scripts

- `npm run dev` — dev server
- `npm run build` / `npm run preview` / `npm run start` — production build/run
- `npm run typecheck` — TypeScript check
- `npm run lint` — ESLint
- `npm run test` — Vitest

## Notes

- Production is AD-only (`AUTH_LOCAL_ENABLED=false`); there is no LOCAL admin.
  The first admin is set by assigning the `ADMINISTRATOR` role to an
  already-logged-in AD user directly in the database.
- Specs live in `.kiro/specs/` (`netops-policy-manager`, `rbac-permissions`,
  `ad-authentication`).
