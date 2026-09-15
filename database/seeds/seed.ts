import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import { createDatabase } from '../index'
import { users } from '../schema/users'
import { roles } from '../schema/roles'
import { permissions } from '../schema/permissions'
import { rolesPermissions } from '../schema/roles-permissions'
import { hashPassword } from '../../server/services/password.service'
import {
  PERMISSION_DEFS,
  ROLE_CODES,
  ROLE_DEFS,
  ROLE_PERMISSION_MAP,
  permissionCode,
} from '../../shared/constants/rbac'

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
    await seedRbac(db)

    const adminRoleId = await roleIdByCode(db, ROLE_CODES.ADMINISTRATOR)

    const existing = await db.query.users.findFirst({
      where: eq(users.email, env.SEED_USER_EMAIL),
    })

    if (existing) {
      // Backfill the role on an already-seeded admin so re-running the seed
      // (e.g. after adding RBAC) grants the ADMINISTRATOR role idempotently.
      if (!existing.roleId && adminRoleId) {
        await db.update(users)
          .set({ roleId: adminRoleId, updatedAt: new Date() })
          .where(eq(users.userId, existing.userId))
        console.log('Assigned ADMINISTRATOR role to the existing development user.')
      }
      else {
        console.log('Development user already exists.')
      }
      return
    }

    const passwordHash = await hashPassword(env.SEED_USER_PASSWORD)

    await db.insert(users).values({
      email: env.SEED_USER_EMAIL,
      displayName: env.SEED_USER_DISPLAY_NAME,
      passwordHash,
      authProvider: 'LOCAL',
      roleId: adminRoleId,
    })

    console.log('Development user created successfully (role: ADMINISTRATOR).')
  }
  finally {
    await client.end()
  }
}

type Db = ReturnType<typeof createDatabase>['db']

/** Look up a role's id by its code, or undefined if not seeded. */
async function roleIdByCode(db: Db, code: string): Promise<string | undefined> {
  const row = await db.query.roles.findFirst({ where: eq(roles.roleCode, code) })
  return row?.roleId
}

/**
 * Idempotently seed roles, permissions, and the role→permission mapping.
 * Re-running is safe: existing rows (matched by their unique codes / pairs) are
 * left in place, missing ones are inserted.
 */
async function seedRbac(db: Db): Promise<void> {
  // Roles
  for (const def of ROLE_DEFS) {
    const found = await db.query.roles.findFirst({ where: eq(roles.roleCode, def.code) })
    if (!found) {
      await db.insert(roles).values({ roleCode: def.code, roleName: def.name, description: def.description })
    }
  }

  // Permissions
  for (const def of PERMISSION_DEFS) {
    const code = permissionCode(def.feature, def.action)
    const found = await db.query.permissions.findFirst({
      where: eq(permissions.permissionCode, code),
    })
    if (!found) {
      await db.insert(permissions).values({
        permissionCode: code,
        feature: def.feature,
        action: def.action,
      })
    }
  }

  // Mapping
  for (const [roleCode, codes] of Object.entries(ROLE_PERMISSION_MAP)) {
    const role = await db.query.roles.findFirst({ where: eq(roles.roleCode, roleCode) })
    if (!role) continue
    for (const code of codes) {
      const perm = await db.query.permissions.findFirst({
        where: eq(permissions.permissionCode, code),
      })
      if (!perm) continue
      const existing = await db.query.rolesPermissions.findFirst({
        where: and(
          eq(rolesPermissions.roleId, role.roleId),
          eq(rolesPermissions.permissionId, perm.permissionId),
        ),
      })
      if (!existing) {
        await db.insert(rolesPermissions).values({
          roleId: role.roleId,
          permissionId: perm.permissionId,
        })
      }
    }
  }

  console.log('RBAC roles, permissions, and mapping seeded.')
}

main().catch((err) => {
  // Never print the password; only surface the error message.
  console.error('Seed failed:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
