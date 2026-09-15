# Design Document — RBAC & Permissions

## Overview

This document designs the **data-driven RBAC** for NetOps Policy Manager. Roles, permissions, and their mapping are persisted in PostgreSQL; a user references at most one role via `users.role_id`. The server resolves a user's effective permissions from these tables and enforces every protected action against them. No authorization decision is hardcoded against a role identifier, so new roles are provisioned as data.

This design maps to the acceptance criteria in this spec's `requirements.md` (referenced inline) and updates the intersecting parts of the main NetOps Policy Manager `requirements.md`/`design.md`.

### Design goals

- **Data-driven** — roles/permissions/mapping are rows, not code (Req 1, 2, 3, 7).
- **One role per user, safe provisioning** — `users.role_id` nullable, `ON DELETE RESTRICT` so provisioning a role never causes accidental mass access changes (Req 4).
- **Server-authoritative** — permissions resolved and enforced on the server; the client only receives its effective permission codes for UX gating (Req 5, 6).
- **Least surprise for future roles** — a new role is one `roles` row + `roles_permissions` rows (Req 7).

## Data Model

### Tables

**`roles`** — master role catalog (Req 1)

| Column | Type | Notes |
|---|---|---|
| `role_id` | uuid PK | `defaultRandom()` |
| `role_code` | varchar(50) | **unique**, not null (e.g. `ADMINISTRATOR`) |
| `role_name` | varchar(100) | not null |
| `description` | text | nullable |
| `is_active` | boolean | not null, default `true` |
| `created_at` | timestamptz | not null, default `now()` |
| `updated_at` | timestamptz | not null, default `now()` |

**`permissions`** — feature + action catalog (Req 2)

| Column | Type | Notes |
|---|---|---|
| `permission_id` | uuid PK | `defaultRandom()` |
| `permission_code` | varchar(100) | **unique**, not null (`<FEATURE>_<ACTION>`) |
| `feature` | varchar(50) | not null (`ACL_POLICIES` \| `ROUTES` \| `ADMINISTRATION`) |
| `action` | varchar(30) | not null (`SHOW` \| `ADD` \| `DELETE` \| `MANAGE`) |
| `description` | text | nullable |
| `is_active` | boolean | not null, default `true` |
| `created_at` | timestamptz | not null, default `now()` |
| `updated_at` | timestamptz | not null, default `now()` |

Unique constraint on (`feature`, `action`) in addition to the unique `permission_code` (Req 2.2).

**`roles_permissions`** — role→permission mapping (Req 3)

| Column | Type | Notes |
|---|---|---|
| `role_permission_id` | uuid PK | `defaultRandom()` |
| `role_id` | uuid | not null, FK → `roles.role_id`, `ON DELETE CASCADE` |
| `permission_id` | uuid | not null, FK → `permissions.permission_id`, `ON DELETE CASCADE` |
| `created_at` | timestamptz | not null, default `now()` |

Unique constraint on (`role_id`, `permission_id`) (Req 3.2).

**`users`** — one new column (Req 4)

| Column | Type | Notes |
|---|---|---|
| `role_id` | uuid | **nullable**, FK → `roles.role_id`, `ON DELETE RESTRICT` |

### Relationships

```
users.role_id ──(RESTRICT)──▶ roles.role_id
roles.role_id ──(CASCADE)──▶ roles_permissions.role_id
permissions.permission_id ──(CASCADE)──▶ roles_permissions.permission_id
```

- One user → at most one role (nullable). RESTRICT protects against deleting a role still in use.
- One role → many permissions, one permission → many roles, via `roles_permissions`.
- Deleting a role or permission cascades only to its mapping rows, never to users.

### Drizzle schema sketch

```typescript
// database/schema/roles.ts
export const roles = pgTable('roles', {
  roleId: uuid('role_id').primaryKey().defaultRandom(),
  roleCode: varchar('role_code', { length: 50 }).notNull().unique(),
  roleName: varchar('role_name', { length: 100 }).notNull(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// database/schema/permissions.ts
export const permissions = pgTable('permissions', {
  permissionId: uuid('permission_id').primaryKey().defaultRandom(),
  permissionCode: varchar('permission_code', { length: 100 }).notNull().unique(),
  feature: varchar('feature', { length: 50 }).notNull(),
  action: varchar('action', { length: 30 }).notNull(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('permissions_feature_action_uidx').on(t.feature, t.action),
]);

// database/schema/roles-permissions.ts
export const rolesPermissions = pgTable('roles_permissions', {
  rolePermissionId: uuid('role_permission_id').primaryKey().defaultRandom(),
  roleId: uuid('role_id').notNull().references(() => roles.roleId, { onDelete: 'cascade' }),
  permissionId: uuid('permission_id').notNull().references(() => permissions.permissionId, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('roles_permissions_role_perm_uidx').on(t.roleId, t.permissionId),
]);

// database/schema/users.ts — added column
//   roleId: uuid('role_id').references(() => roles.roleId, { onDelete: 'restrict' }),  // nullable
```

## Initial Data (seed)

Applied via the existing `db:seed` command (Req 1.3, 2.3, 3.4; NFR Maintainability 2). Idempotent upserts keyed on the unique codes.

### Roles

| role_code | role_name | is_active |
|---|---|---|
| `ADMINISTRATOR` | Administrator | true |
| `L2_ENGINEER` | L2 Engineer | true |
| `NOC` | NOC | true |

### Permissions

| permission_code | feature | action |
|---|---|---|
| `ACL_POLICIES_SHOW` | ACL_POLICIES | SHOW |
| `ACL_POLICIES_ADD` | ACL_POLICIES | ADD |
| `ACL_POLICIES_DELETE` | ACL_POLICIES | DELETE |
| `ROUTES_SHOW` | ROUTES | SHOW |
| `ROUTES_ADD` | ROUTES | ADD |
| `ROUTES_DELETE` | ROUTES | DELETE |
| `ADMINISTRATION_SHOW` | ADMINISTRATION | SHOW |
| `ADMINISTRATION_MANAGE` | ADMINISTRATION | MANAGE |

### Mapping

| Role | Permissions |
|---|---|
| **NOC** | `ACL_POLICIES_SHOW`, `ACL_POLICIES_ADD`, `ROUTES_SHOW`, `ROUTES_ADD` |
| **L2_ENGINEER** | `ACL_POLICIES_SHOW`, `ACL_POLICIES_ADD`, `ACL_POLICIES_DELETE`, `ROUTES_SHOW`, `ROUTES_ADD`, `ROUTES_DELETE` |
| **ADMINISTRATOR** | all six ACL/Route permissions + `ADMINISTRATION_SHOW`, `ADMINISTRATION_MANAGE` |

The seeded admin account (from `SEED_USER_*` env) is assigned `role_id` of `ADMINISTRATOR`.

## Permission Resolution & Enforcement

### Resolving effective permissions

On each authenticated request (in the session middleware that already resolves the user), the server computes the user's effective permission codes with a single join and caches them on `event.context.auth`:

```
SELECT p.permission_code
FROM users u
JOIN roles r              ON r.role_id = u.role_id AND r.is_active = true
JOIN roles_permissions rp ON rp.role_id = r.role_id
JOIN permissions p        ON p.permission_id = rp.permission_id AND p.is_active = true
WHERE u.user_id = :userId
```

- `role_id = null` → the join yields no rows → empty permission set (Req 4.3).
- Inactive role or inactive permission → excluded (Req 1.4, 2.5).

```typescript
// server/auth/permissions.ts
export type PermissionCode = string;              // 'ACL_POLICIES_ADD', ...
interface AuthContext { user: AuthUser; permissions: Set<PermissionCode> }

export function hasPermission(auth: AuthContext, code: PermissionCode): boolean {
  return auth.permissions.has(code);              // Req 5.2
}

export function requirePermission(event, code: PermissionCode): AuthUser {
  const auth = event.context.auth as AuthContext | undefined;
  if (!auth?.user) throw new AppError('UNAUTHENTICATED', 401);   // Req 5.3
  if (!hasPermission(auth, code)) throw new AppError('FORBIDDEN', 403); // Req 5.4
  return auth.user;
}
```

No function branches on `role_code`; decisions read only from the resolved set (Req 5.6, 1.5).

### Endpoint → permission map (this phase)

| Method | Path | Required permission |
|---|---|---|
| GET | `/api/acl`, `/api/acl/:id` | `ACL_POLICIES_SHOW` |
| POST | `/api/acl` | `ACL_POLICIES_ADD` |
| DELETE | `/api/acl/:id` | `ACL_POLICIES_DELETE` |
| GET | `/api/routes`, `/api/routes/:id` | `ROUTES_SHOW` |
| POST | `/api/routes` | `ROUTES_ADD` |
| DELETE | `/api/routes/:id` | `ROUTES_DELETE` |
| GET | `/api/users`, `/api/users/:id` | `ADMINISTRATION_SHOW` |
| POST/PATCH/DELETE user mgmt | `/api/users*` | `ADMINISTRATION_MANAGE` |
| GET | `/api/dashboard/summary` | valid session only |
| GET | `/api/audit*` (Log Trail) | valid session only |

### Frontend gating

- `GET /api/auth/me` returns the user's effective permission codes (Req 5.7).
- `usePermissions().can(code)` drives menu visibility in `AppSidebar` and enables/disables the Add/Delete buttons on the ACL and Routes pages (Req 6).
- Dashboard and Log Trail links are always shown (Req 6.4). The server re-enforces every action regardless of what the UI shows (Req 6.5).

## Impact on Existing Specs

Only the intersecting parts of the main spec were changed:

- **Main `requirements.md`** — Requirement 2 (Authorization) rewritten to the data-driven model; Requirement 3 (Administration) now uses `ADMINISTRATION_SHOW`/`MANAGE`; Requirement 8 (Log Trail) opened to all authenticated users; glossary Permission/Role and Requirement 10 table list (`permissions`, `roles_permissions` instead of `user_roles`) updated.
- **Main `design.md`** — the hardcoded `ROLE_PERMISSIONS` block replaced with data-driven `hasPermission`/`requirePermission`; the Drizzle schema section replaced `roles`/`user-roles` with `roles`/`permissions`/`roles_permissions` + `users.role_id`; the API endpoint permission column and Property 12 updated.

Unchanged: session/MFA design, network validation, command generation, audit transactionality, packaging.

## Migration & Seeding (planned — not generated yet)

Per the user's instruction, no migration is generated and no database change is made in this design phase. When approved, implementation will:

1. Add `roles`, `permissions`, `roles_permissions` tables and the nullable `users.role_id` column (with `ON DELETE RESTRICT`).
2. Generate the Drizzle migration via `db:generate` (apply only via `db:migrate` by the operator).
3. Seed roles, permissions, and mapping (idempotent) and assign the initial admin the `ADMINISTRATOR` role via `db:seed`.

## Out of Scope

Same as this spec's `requirements.md`: no multi-role, no ACL/Route `UPDATE` action, no row-level permissions, no role-editing UI, and no permission gating for Dashboard/Log Trail.
