# Requirements Document — Database (Schema)

## Introduction

This spec is the authoritative document for the **PostgreSQL database schema** of
NetOps Policy Manager. It describes every table, enum, column, relationship,
index, and constraint as defined in the Drizzle ORM schema under
`database/schema/*.ts`, plus the connection, migration, and seed posture.

The database is an **identity / RBAC / session / audit layer, not the source of
truth** for ACL/route device state. There are deliberately **no
`acl_policies` / `routes` configuration-state tables** — live device state lives
on the devices and is reached only through n8n. iTop is a **foreign, read-only
MariaDB** reached directly with `mysql2` and is **not part of this Drizzle
schema** (see `ticketing-itop/`).

All tables, enums, and `$inferSelect`/`$inferInsert` types are re-exported from
`database/schema/index.ts`. The connection factory is `createDatabase()` in
`database/index.ts` (postgres.js driver, pool `max: 10`), exposing the `Database`
and `DbOrTx` types used across repositories and services.

Related specs:

- **general/** — system overview, layering, and the no-provisioning posture.
- **authentication/** — how `users`, `user_mfa`, and `sessions` are used.
- **rbac-permissions/** — the data-driven meaning of `roles`, `permissions`, `roles_permissions`.
- **log-trail/** — how `audit_logs`, `acl_logs`, and `route_logs` are read/written.

### Scope

In scope: the ten tables and their enums, columns, keys, foreign keys, indexes,
and the delete behaviors; the connection factory; the migrate/seed posture.
Out of scope: the business logic that reads/writes these tables (owned by the
module specs), the iTop MariaDB (foreign, not Drizzle), and any ACL/route
device-configuration storage (there is none).

## Glossary

- **Data_Layer**: The Drizzle ORM schema + query layer over PostgreSQL; the only layer that touches Drizzle.
- **Identity_Core**: The `users`, `user_mfa`, and `sessions` tables.
- **RBAC_Core**: The `roles`, `permissions`, and `roles_permissions` tables.
- **Audit_Core**: The `audit_logs` master table plus the `acl_logs` / `route_logs` detail tables.
- **Master_Audit_Row**: A single `audit_logs` row — the system of record for one operation.
- **Detail_Log_Row**: An `acl_logs` / `route_logs` row holding deeper execution-inspection detail for a sensitive ACL/ROUTE operation, written in the SAME transaction as its master audit row.

## Requirements

### Requirement 1: Connection and provisioning posture

**User Story:** As an operator, I want the app to connect to an existing PostgreSQL instance without ever provisioning or mutating schema on its own, so that the database lifecycle stays under operator control.

#### Acceptance Criteria

1. THE Data_Layer SHALL connect through `createDatabase(databaseUrl)` (postgres.js) with a bounded pool (`max: 10`, `idle_timeout: 20`, `connect_timeout: 10`) and SHALL expose a Drizzle client bound to the full `schema`.
2. THE application SHALL NEVER create the database, auto-migrate on startup, or fall back to an embedded/SQLite database.
3. THE Data_Layer SHALL route every query through Drizzle (parameterized); no module SHALL build raw concatenated SQL.
4. THE Data_Layer SHALL expose a `DbOrTx` type so repository/service functions can run standalone or inside a `db.transaction(...)`.
5. THE schema SHALL be defined in `database/schema/*.ts` and re-exported from `database/schema/index.ts`; migrations are generated with `npm run db:generate` and applied by the operator with `npm run db:migrate` (never by the app).

### Requirement 2: Enumerated types

**User Story:** As a developer, I want the Postgres enums fixed and documented, so that enum values and their append-only history are unambiguous.

#### Acceptance Criteria

1. THE schema SHALL define `auth_provider` as `['LOCAL', 'AD']`.
2. THE schema SHALL define `mfa_type` as `['TOTP']`.
3. THE schema SHALL define `audit_module` as `['AUTH', 'USER', 'ACL', 'ROUTE', 'N8N']`.
4. THE schema SHALL define `audit_action` as `['LOGIN', 'SHOW', 'ADD', 'DELETE', 'UPDATE', 'LOGOUT', 'MFA_VERIFY']`, in that order (`LOGOUT` then `MFA_VERIFY` were appended by later migrations via `ALTER TYPE ... ADD VALUE`; existing values are never reordered).
5. THE schema SHALL define `audit_status` as `['SUCCESS', 'FAILED']`.
6. THE schema SHALL define `exec_log_action` as `['SHOW', 'ADD', 'DELETE']` and `exec_log_status` as `['SUCCESS', 'FAILED']`, declared ONCE in `acl-logs.ts` and imported by `route-logs.ts` (Postgres enum names are global and SHALL NOT be redefined).

### Requirement 3: `roles` table (RBAC_Core)

**User Story:** As a security administrator, I want roles stored as data, so that roles can be added or retired without code changes.

#### Acceptance Criteria

1. THE `roles` table SHALL have: `role_id` (uuid PK, default random), `role_code` (varchar 50, not null), `role_name` (varchar 100, not null), `description` (text, nullable), `is_active` (boolean, not null, default true), `created_at` and `updated_at` (timestamptz, not null, default now()).
2. THE `roles` table SHALL enforce a UNIQUE index on `role_code` (`roles_role_code_uidx`).
3. A role SHALL be retired by setting `is_active = false`, never by deletion while any user references it (see Requirement 7, `users.role_id` ON DELETE RESTRICT).
4. THE initial seeded roles SHALL be `ADMINISTRATOR`, `L2_ENGINEER`, and `NOC`.

### Requirement 4: `permissions` table (RBAC_Core)

**User Story:** As a security administrator, I want permissions expressed as feature + action, so that access maps directly to product capabilities.

#### Acceptance Criteria

1. THE `permissions` table SHALL have: `permission_id` (uuid PK, default random), `permission_code` (varchar 100, not null), `feature` (varchar 50, not null), `action` (varchar 30, not null), `description` (text, nullable), `is_active` (boolean, not null, default true), `created_at` and `updated_at` (timestamptz, not null, default now()).
2. THE `permissions` table SHALL enforce a UNIQUE index on `permission_code` (`permissions_permission_code_uidx`) and a UNIQUE index on the pair (`feature`, `action`) (`permissions_feature_action_uidx`).
3. THE `permission_code` SHALL equal `<feature>_<action>`.
4. THE initial seeded permissions SHALL be `ACL_POLICIES_{SHOW,ADD,DELETE}`, `ROUTES_{SHOW,ADD,DELETE}`, and `ADMINISTRATION_{SHOW,MANAGE}`.

### Requirement 5: `roles_permissions` table (RBAC_Core)

**User Story:** As a security administrator, I want a mapping table granting permissions to roles, so that a role's access is a composable set of capabilities.

#### Acceptance Criteria

1. THE `roles_permissions` table SHALL have: `role_permission_id` (uuid PK, default random), `role_id` (uuid, not null, FK → `roles.role_id`), `permission_id` (uuid, not null, FK → `permissions.permission_id`), `created_at` (timestamptz, not null, default now()).
2. BOTH foreign keys SHALL use ON DELETE CASCADE, so removing a role or a permission removes only its mapping rows (never touching `users`).
3. THE table SHALL enforce a UNIQUE index on the pair (`role_id`, `permission_id`) (`roles_permissions_role_perm_uidx`) to prevent duplicate grants.

### Requirement 6: `users` table (Identity_Core)

**User Story:** As an administrator, I want each account's identity, origin, and role stored, so that both LOCAL and AD users are represented consistently.

#### Acceptance Criteria

1. THE `users` table SHALL have: `user_id` (uuid PK, default random), `email` (varchar 255, not null), `display_name` (varchar 150, not null), `username` (varchar 300, nullable — the AD `sAMAccountName`), `password_hash` (text, nullable — Argon2 for LOCAL, null for AD), `auth_provider` (`auth_provider` enum, not null, default `LOCAL`), `external_id` (varchar 255, nullable — AD `objectGUID`), `role_id` (uuid, nullable, FK → `roles.role_id`), `is_active` (boolean, not null, default true), `last_login_at` (timestamptz, nullable), `created_at` and `updated_at` (timestamptz, not null, default now()).
2. THE `role_id` foreign key SHALL use ON DELETE RESTRICT, so a role still assigned to any user cannot be deleted.
3. A user whose `role_id` is null SHALL hold no feature permissions (common access only — Dashboard + Log Trail).
4. THE table SHALL enforce a UNIQUE index on `email` (`users_email_uidx`), a UNIQUE index on `external_id` (`users_external_id_uidx`), and a PARTIAL UNIQUE index on `username` WHERE `username IS NOT NULL` (`users_username_uidx`) so the many LOCAL rows with a null username do not collide.
5. THE table SHALL have a non-unique index on `role_id` (`users_role_id_idx`).

### Requirement 7: `user_mfa` table (Identity_Core)

**User Story:** As a user, I want my TOTP devices stored with the secret encrypted, so that my second factor is secure and I can enrol more than one device.

#### Acceptance Criteria

1. THE `user_mfa` table SHALL have: `mfa_id` (uuid PK, default random), `user_id` (uuid, not null, FK → `users.user_id`, ON DELETE CASCADE), `mfa_type` (`mfa_type` enum, not null, default `TOTP`), `label` (text, not null, default `Authenticator`), `secret_encrypted` (text, not null — AES-256-GCM ciphertext), `is_enabled` (boolean, not null, default false), `verified_at` (timestamptz, nullable), `created_at` and `updated_at` (timestamptz, not null, default now()).
2. THE `secret_encrypted` column SHALL store only AES-256-GCM ciphertext of the TOTP secret; the plaintext secret SHALL NEVER be persisted.
3. THE table SHALL have a non-unique index on `user_id` (`user_mfa_user_id_idx`) and SHALL NOT have a unique index on `user_id`, so a user MAY enrol more than one device (the "at most two devices" cap is enforced in the service layer, not by a DB constraint).

### Requirement 8: `sessions` table (Identity_Core)

**User Story:** As a security administrator, I want sessions stored as token hashes only, so that a database read never reveals a usable session token.

#### Acceptance Criteria

1. THE `sessions` table SHALL have: `session_id` (uuid PK, default random), `user_id` (uuid, not null, FK → `users.user_id`, ON DELETE CASCADE), `token_hash` (text, not null — SHA-256 of the raw token), `expires_at` (timestamptz, not null), `created_at` (timestamptz, not null, default now()), `last_used_at` (timestamptz, nullable), `source_ip` (varchar 64, nullable), `user_agent` (varchar 512, nullable), `device_cred_encrypted` (text, nullable), `device_cred_expires_at` (timestamptz, nullable).
2. THE raw session token SHALL NEVER be stored; only `token_hash` (SHA-256) is persisted, and the raw token lives solely in the `netops_session` HttpOnly cookie.
3. A `sessions` row SHALL exist only after MFA has succeeded.
4. THE `device_cred_encrypted` column SHALL hold AES-256-GCM ciphertext of the engineer's device username/password (for read operations), never cleartext and never audited/logged; the credentials are removed with the row on logout/expiry or cleared manually. (`device_cred_expires_at` is retained in the schema but the device credentials currently live for the login-session lifetime — see n8n-integration/.)
5. THE table SHALL enforce a UNIQUE index on `token_hash` (`sessions_token_hash_uidx`) and non-unique indexes on `user_id` (`sessions_user_id_idx`) and `expires_at` (`sessions_expires_at_idx`).

### Requirement 9: `audit_logs` table (Audit_Core — master system of record)

**User Story:** As a security administrator, I want every operation recorded immutably with a redacted payload, so that there is a complete, secret-free audit trail.

#### Acceptance Criteria

1. THE `audit_logs` table SHALL have: `id` (uuid PK, default random), `user_id` (uuid, nullable, FK → `users.user_id`, ON DELETE SET NULL), `username` (varchar 150, nullable — actor snapshot), `user_role` (varchar 100, nullable — actor role snapshot), `module` (`audit_module` enum, not null), `action` (`audit_action` enum, not null), `status` (`audit_status` enum, not null), `source_ip` (varchar 64, nullable), `user_agent` (varchar 512, nullable), `change_ticket` (varchar 64, nullable), `correlation_id` (uuid, NOT NULL), `created_at` (timestamptz, not null, default now()), and four JSONB payload columns: `request_payload`, `command_payload`, `execution_payload`, `response_payload`.
2. THE `user_id` foreign key SHALL use ON DELETE SET NULL so an audit row survives deletion of the user it referenced (audit rows are never deleted during normal operation).
3. THE `username` and `user_role` columns SHALL be point-in-time snapshots that survive later user/role changes.
4. EVERY column and all four JSONB payloads SHALL be written only AFTER redaction — execution credentials, the n8n API key, session tokens, and any secret SHALL NEVER be persisted; credentials appear only as `***`.
5. THE four JSONB payload columns SHALL be intentionally flexible so their shape can track n8n's evolving request/response without a migration.
6. THE table SHALL have non-unique indexes on `created_at`, `user_id`, `module`, `action`, `status`, `change_ticket`, and `correlation_id` to support the Log Trail filters.

### Requirement 10: `acl_logs` and `route_logs` tables (Audit_Core — detail complement)

**User Story:** As a security administrator, I want deeper execution-inspection detail for sensitive ACL/ROUTE operations linked to the master audit row, so that one operation's full detail is inspectable and consistent.

#### Acceptance Criteria

1. THE `acl_logs` and `route_logs` tables SHALL each COMPLEMENT `audit_logs` (never replace it); `audit_logs` SHALL still record every ACL/ROUTE operation.
2. EACH detail row SHALL link to its master audit row via `audit_id` (uuid, not null, FK → `audit_logs.id`, ON DELETE CASCADE) and SHALL share the operation's `correlation_id` (uuid, not null); it SHALL be written in the SAME DB transaction as its master audit row.
3. THE `acl_logs` table SHALL have: `id` (uuid PK), `audit_id`, `correlation_id`, `action` (`exec_log_action`), `status` (`exec_log_status`), `device` (varchar 255, nullable), `source` (varchar 255, nullable), `destination` (varchar 255, nullable), `command_preview` (jsonb — redacted command lines, null for SHOW), `execution_meta` (jsonb — redacted), `response_summary` (jsonb — redacted `{ total, message, output, error }`), `created_at` (timestamptz, default now()); indexes on `created_at`, `correlation_id`, `audit_id`.
4. THE `route_logs` table SHALL mirror `acl_logs` but SHALL replace `source` with `change_ticket` (varchar 64, nullable) while keeping `destination`; it SHALL add an index on `change_ticket` (in addition to `created_at`, `correlation_id`, `audit_id`).
5. THE three JSONB columns on both detail tables SHALL be written only AFTER redaction; `source`/`destination` hold human-readable "IP MASK" inputs (non-secret) and `change_ticket` is a non-secret reference.
6. THE application SHALL expose no update or delete path for `acl_logs` / `route_logs`; detail rows are removed only by the `audit_id` CASCADE when their master row is removed.

## Non-Functional Requirements

### Security

1. THE Data_Layer SHALL never persist a password, password hash for AD accounts, raw session token, TOTP plaintext secret, device credential plaintext, or any n8n credential; secrets are encrypted (AES-256-GCM), hashed (Argon2 for LOCAL passwords, SHA-256 for session tokens), or redacted to `***` before write.
2. ALL queries SHALL be parameterized through Drizzle.

### Integrity

1. THE delete behaviors SHALL be exactly: `users.role_id` RESTRICT; `user_mfa.user_id`, `sessions.user_id`, `roles_permissions.{role_id,permission_id}`, and `{acl,route}_logs.audit_id` CASCADE; `audit_logs.user_id` SET NULL.
2. AUDIT rows SHALL be append-only in normal operation (no update/delete path exposed).

## Migration history (reference — generated, operator-applied)

Migrations live in `database/migrations/` (Drizzle journal version 7). They are
generated with `npm run db:generate` and applied by the operator with
`npm run db:migrate`; the app never applies them. The current journal:

| Tag | Purpose (summary) |
| --- | --- |
| `0000_sharp_gauntlet` | Initial identity schema (`users`, `user_mfa`, `auth_provider`/`mfa_type` enums). |
| `0001_add_sessions` | `sessions` table (hash-only tokens). |
| `0002_mfa_multi_device` | Multi-device MFA (drop single-device cap; add `label`). |
| `0003_rbac` | `roles`, `permissions`, `roles_permissions`; `users.role_id`. |
| `0004_conscious_jack_murdock` | Audit/feature-domain tables (`audit_logs` + enums). |
| `0005_sticky_wallflower` | Device Session Credentials columns on `sessions`. |
| `0006_adorable_leech` | `acl_logs` / `route_logs` detail tables + `exec_log_*` enums. |
| `0007_easy_morph` | `audit_action` += `LOGOUT`. |
| `0008_quiet_wild_pack` | `audit_action` += `MFA_VERIFY`. |
| `0009_previous_elektra` | Later schema adjustment (generated). |

> The exact DDL of each migration lives in the corresponding
> `database/migrations/00XX_*.sql` file; the one-line purposes above are a
> reading aid and the SQL files remain authoritative. There are also hand-kept
> production helpers in `database/` (`prod-schema.sql`, `prod-seed-rbac.sql`,
> `prod-admin-promote.sql`) used for operator-run production bootstrap.

## Seed data (reference)

The development seed (`database/seeds/seed.ts`, run manually via `npm run db:seed`,
never at startup) is idempotent and creates the first LOCAL user from
`SEED_USER_*`, never logging the password. The RBAC roles, permissions, and
mapping are sourced from `shared/constants/rbac.ts` (`ROLE_DEFS`,
`PERMISSION_DEFS`, `ROLE_PERMISSION_MAP`). See **rbac-permissions/** for the
seeded role→permission grants.

## Cross-references

- **general/** — connection posture, layering, no-provisioning rule.
- **authentication/** — `users` / `user_mfa` / `sessions` behavior.
- **rbac-permissions/** — meaning of `roles` / `permissions` / `roles_permissions` and the seeded grants.
- **log-trail/** — read/write of `audit_logs` / `acl_logs` / `route_logs`.
- **n8n-integration/** — device-credential columns and the redacted n8n capture in audit payloads.
- **ticketing-itop/** — the foreign iTop MariaDB (NOT part of this schema).
