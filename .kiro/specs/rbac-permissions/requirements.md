# Requirements Document — RBAC & Permissions

## Introduction

This spec defines the **data-driven Role-Based Access Control (RBAC)** model for
NetOps Policy Manager. Authorization is decided entirely from persisted data —
roles, permissions, and their mapping live in the database — so new roles are
introduced by inserting data, never by changing code. This is the single source
of truth for the RBAC model; it folds in the data-model and resolution detail
that previously lived in a separate design document.

Cross-links: `general/` (envelope, layering), `authentication/` (an AD user is
provisioned with `role_id = null` and the first admin is bootstrapped directly in
the database).

Scope:

- The master `roles` table, the `permissions` catalog (feature + action), and the `roles_permissions` mapping.
- The `users.role_id` association (one role per user for now).
- The seeded roles, permissions, and mapping.
- Server-side enforcement from resolved permissions, and frontend menu/button gating.
- Constraints and future-role support.

## Glossary

- **Role**: A named grouping of Permissions, persisted in `roles`. Identified logically by `role_code`. A user has at most one Role.
- **Permission**: A capability defined as a `feature` + `action` pair, persisted in `permissions` and referenced in code by `permission_code` = `<FEATURE>_<ACTION>`.
- **Feature**: A gated area of the product: `ACL_POLICIES`, `ROUTES`, `ADMINISTRATION`.
- **Action**: An operation within a feature: `SHOW`, `ADD`, `DELETE` (and `MANAGE` for `ADMINISTRATION`).
- **Role→Permission mapping**: Rows in `roles_permissions` that grant a Permission to a Role.
- **Effective Permissions**: The set of `permission_code` values resolved for a user by joining the user's active Role to its active mapped Permissions.
- **Authorization_Service**: The server component that resolves and enforces Effective Permissions (`hasPermission` / `requirePermission`).

## Requirements

### Requirement 1: Role catalog

**User Story:** As a security administrator, I want roles stored as data, so that roles can be added or retired without code changes.

#### Acceptance Criteria

1. THE Data_Layer SHALL persist roles in a `roles` table with `role_id` (UUID PK, `defaultRandom`), `role_code` (varchar(50), unique, not null), `role_name` (varchar(100), not null), `description` (text, nullable), `is_active` (boolean, not null, default true), `created_at`, and `updated_at` (timestamptz, not null, default now).
2. THE Data_Layer SHALL enforce a unique constraint on `roles.role_code`.
3. THE system SHALL seed the initial roles `ADMINISTRATOR`, `L2_ENGINEER`, and `NOC`.
4. THE Authorization_Service SHALL treat a role with `is_active = false` as granting no Permissions.
5. THE system SHALL NOT hardcode role identifiers in authorization logic (e.g. `role === 'NOC'`).

### Requirement 2: Permission catalog

**User Story:** As a security administrator, I want permissions expressed as feature + action, so that access maps directly to product capabilities.

#### Acceptance Criteria

1. THE Data_Layer SHALL persist permissions in a `permissions` table with `permission_id` (UUID PK), `permission_code` (varchar(100), unique, not null), `feature` (varchar(50), not null), `action` (varchar(30), not null), `description` (nullable), `is_active` (not null, default true), `created_at`, and `updated_at`.
2. THE Data_Layer SHALL enforce a unique constraint on `permissions.permission_code` and a unique constraint on the pair (`feature`, `action`).
3. THE system SHALL seed exactly these eight permissions: `ACL_POLICIES_SHOW`, `ACL_POLICIES_ADD`, `ACL_POLICIES_DELETE`, `ROUTES_SHOW`, `ROUTES_ADD`, `ROUTES_DELETE`, `ADMINISTRATION_SHOW`, and `ADMINISTRATION_MANAGE`.
4. THE `permission_code` SHALL equal `<feature>_<action>` for every permission.
5. THE Authorization_Service SHALL treat a permission with `is_active = false` as not granted, even if mapped to a role.

### Requirement 3: Role→Permission mapping

**User Story:** As a security administrator, I want to grant permissions to roles via a mapping table, so that a role's access is a composable set of capabilities.

#### Acceptance Criteria

1. THE Data_Layer SHALL persist the mapping in a `roles_permissions` table with `role_permission_id` (UUID PK), `role_id` (not null, FK → `roles.role_id`), `permission_id` (not null, FK → `permissions.permission_id`), and `created_at`.
2. THE Data_Layer SHALL enforce a unique constraint on the pair (`role_id`, `permission_id`) to prevent duplicate grants.
3. THE `roles_permissions.role_id` and `roles_permissions.permission_id` foreign keys SHALL use `ON DELETE CASCADE`.
4. THE system SHALL seed the initial mapping:
   - `NOC` → `ACL_POLICIES_SHOW`, `ACL_POLICIES_ADD`, `ROUTES_SHOW`, `ROUTES_ADD`.
   - `L2_ENGINEER` → `ACL_POLICIES_SHOW`, `ACL_POLICIES_ADD`, `ACL_POLICIES_DELETE`, `ROUTES_SHOW`, `ROUTES_ADD`, `ROUTES_DELETE`.
   - `ADMINISTRATOR` → all six ACL/Route permissions plus `ADMINISTRATION_SHOW` and `ADMINISTRATION_MANAGE`.

### Requirement 4: User–Role association

**User Story:** As an administrator, I want each user assigned exactly one role, so that access is predictable and simple to manage.

#### Acceptance Criteria

1. THE Data_Layer SHALL define a nullable `role_id` column on `users` as a foreign key to `roles.role_id`.
2. THE `users.role_id` foreign key SHALL use `ON DELETE RESTRICT`, so a role still assigned to any user cannot be deleted.
3. THE Authorization_Service SHALL treat a user whose `role_id` is null as holding no feature Permissions (common access: Dashboard and Log Trail only).
4. WHEN an administrator changes a user's role, THE system SHALL set `users.role_id` to exactly one role.
5. THE system SHALL support retiring a role by setting `roles.is_active = false` rather than deleting it while users are assigned.
6. WHEN a user is provisioned from Active Directory on first login, THE system SHALL create the user with `role_id = null` and SHALL NOT assign any role automatically (see the `authentication/` spec).
7. WHERE a deployment authenticates entirely through Active Directory, THE first administrator SHALL be established by an operator assigning the `ADMINISTRATOR` role to an already-provisioned AD user directly in the database (setting `users.role_id`), after that user has logged in at least once.

### Requirement 5: Permission resolution and enforcement

**User Story:** As a security administrator, I want every protected action checked against the user's resolved permissions on the server, so that access cannot be bypassed by the client.

#### Acceptance Criteria

1. THE Authorization_Service SHALL resolve a user's Effective Permissions by joining `users.role_id` → `roles` (active) → `roles_permissions` → `permissions` (active); a null `role_id`, an inactive role, or an inactive permission yields no grant.
2. THE Authorization_Service SHALL expose `hasPermission(permissionSet, code)` and `requirePermission(event, code)` that evaluate Effective Permissions.
3. IF a request to a protected endpoint has no valid session, THEN THE API_Layer SHALL reject it with HTTP 401 (`UNAUTHENTICATED`).
4. IF a request to a protected endpoint has a valid session but the resolved permissions do not include the required Permission, THEN THE API_Layer SHALL reject it with HTTP 403 (`FORBIDDEN`).
5. THE API_Layer SHALL enforce the Permission check on the server independently of any Frontend behavior.
6. THE Authorization_Service SHALL base every authorization decision on Effective Permissions and SHALL NOT branch on specific role identifiers.
7. THE `GET /api/auth/me` response SHALL include the authenticated user's Effective Permissions so the Frontend can gate menus and buttons.

### Requirement 6: Feature-to-permission gating

**User Story:** As an operator, I want to see only the menus and actions I'm allowed to use, so that the interface matches my access.

#### Acceptance Criteria

1. THE Frontend SHALL gate the ACL Policies view behind `ACL_POLICIES_SHOW`, the ACL create action behind `ACL_POLICIES_ADD`, and the ACL delete action behind `ACL_POLICIES_DELETE`.
2. THE Frontend SHALL gate the Routes view behind `ROUTES_SHOW`, the Route create action behind `ROUTES_ADD`, and the Route delete action behind `ROUTES_DELETE`.
3. THE Frontend SHALL gate the Administration menu/view behind `ADMINISTRATION_SHOW` and the user-management actions behind `ADMINISTRATION_MANAGE`.
4. THE Frontend SHALL always show the Dashboard and Log Trail menus to every authenticated user, without requiring any Permission.
5. WHERE a user lacks the Permission for a menu or action, THE Frontend SHALL hide or disable it, and THE server SHALL still re-enforce the Permission on the corresponding request.
6. THE sidebar (`app/components/layout/AppSidebar.vue`) SHALL present ACL Policies and Routes as parent GROUPS that are empty folders — each has NO page of its own and only expands/collapses — whose children are the real pages: ACL Policies → Show ACL (`/acl`), Add ACL (`/acl/add`), Delete ACL (`/acl/delete`); Routes → Show Route (`/routes`), Add Route (`/routes/add`), Delete Route (`/routes/delete`). The active highlight SHALL follow the open submenu by longest-prefix match, the parent branch SHALL stay highlighted while one of its children is active, and the branch SHALL auto-expand on the active route.
7. THE folder-style menu SHALL NOT change RBAC/permissions: the parent group SHALL keep the `*_SHOW` visibility gate (so the whole group hides for a user without ACL/Route access) and each child SHALL keep its original permission — Show behind `*_SHOW`, Add behind `*_ADD`, Delete behind `*_DELETE`. The seeded roles, permissions, and mapping are unchanged.

### Requirement 7: Future-role support

**User Story:** As a security administrator, I want to introduce new roles later, so that access policy can evolve without migrations or code changes.

#### Acceptance Criteria

1. THE schema SHALL allow a new role to be created by inserting a `roles` row and the desired `roles_permissions` rows, with no schema change and no code change.
2. THE schema SHALL allow any combination of existing Permissions to be granted to any role.
3. WHEN a new Permission is genuinely required, THE change SHALL be limited to adding a `permissions` row (and mapping rows); existing roles SHALL remain unaffected until explicitly mapped.

## Data model (consolidated)

The relationships enforced by the schema:

```
users.role_id ──(ON DELETE RESTRICT)──▶ roles.role_id
roles.role_id ──(ON DELETE CASCADE)───▶ roles_permissions.role_id
permissions.permission_id ──(ON DELETE CASCADE)──▶ roles_permissions.permission_id
```

- One user → at most one role (nullable). RESTRICT protects a role still in use.
- One role ↔ many permissions via `roles_permissions`.
- Deleting a role or permission cascades only to its mapping rows, never to users.

### Seeded data (applied via `db:seed`, idempotent on the unique codes)

Roles: `ADMINISTRATOR` (Administrator), `L2_ENGINEER` (L2 Engineer), `NOC` (NOC) — all `is_active = true`.

Permissions (eight): `ACL_POLICIES_{SHOW,ADD,DELETE}`, `ROUTES_{SHOW,ADD,DELETE}`, `ADMINISTRATION_{SHOW,MANAGE}`.

Mapping:

| Role | Permissions |
|---|---|
| **NOC** | `ACL_POLICIES_SHOW`, `ACL_POLICIES_ADD`, `ROUTES_SHOW`, `ROUTES_ADD` |
| **L2_ENGINEER** | `ACL_POLICIES_SHOW`, `ACL_POLICIES_ADD`, `ACL_POLICIES_DELETE`, `ROUTES_SHOW`, `ROUTES_ADD`, `ROUTES_DELETE` |
| **ADMINISTRATOR** | all six ACL/Route permissions + `ADMINISTRATION_SHOW`, `ADMINISTRATION_MANAGE` |

In development, the seeded LOCAL admin (from `SEED_USER_*`) is assigned the
`ADMINISTRATOR` role (and the role is backfilled idempotently on re-seed). AD
users are provisioned with `role_id = null` and receive a role only when an
administrator assigns one; in an AD-only deployment the first administrator is
bootstrapped by an operator setting `users.role_id` to `ADMINISTRATOR` directly
in the database after that user's first login.

### Resolution and enforcement (how it works in code)

The Authorization_Service resolves effective permission codes with one join
(`users → active roles → roles_permissions → active permissions`) and checks a
`Set<string>` for O(1) membership. `requirePermission(event, code)` throws
`UNAUTHENTICATED` (401) when there is no session and `FORBIDDEN` (403) when the
code is absent; no function branches on `role_code`. The seed data and the stable
permission/role code strings referenced by handlers and the UI are defined once
in `shared/constants/rbac.ts` (`PERMISSIONS`, `ROLE_CODES`, `ROLE_DEFS`,
`PERMISSION_DEFS`, `ROLE_PERMISSION_MAP`).

### Endpoint → permission map (current phase)

ACL/Route endpoints are singular n8n-ops endpoints. `preview`/`execute` require
`*_ADD` or `*_DELETE` resolved from the request `operation` field.

| Method | Path | Required permission |
|---|---|---|
| POST | `/api/acl/show` | `ACL_POLICIES_SHOW` |
| POST | `/api/acl/preview`, `/api/acl/execute` | `ACL_POLICIES_ADD` (op=ADD) / `ACL_POLICIES_DELETE` (op=DELETE) |
| POST | `/api/route/show` | `ROUTES_SHOW` |
| POST | `/api/route/preview`, `/api/route/execute` | `ROUTES_ADD` (op=ADD) / `ROUTES_DELETE` (op=DELETE) |
| GET | `/api/users`, `/api/users/:id` | `ADMINISTRATION_SHOW` |
| PATCH | `/api/users/:id`, `/api/users/:id/role`, `/api/users/:id/status` | `ADMINISTRATION_MANAGE` |
| POST | `/api/users`, `/api/users/:id/reset-password` | `ADMINISTRATION_MANAGE` — **DISABLED** in the current build (reject; accounts come from AD) — see the `user-management/` spec |
| GET | `/api/dashboard/*`, `/api/audit*`, `/api/acl-logs*`, `/api/route-logs*` | valid session only (common access) |

### Frontend gating

`GET /api/auth/me` returns the user's effective permission codes; a `can(code)`
check drives menu visibility and enables/disables the Add/Delete buttons.
Dashboard and Log Trail are always shown. The server re-enforces every action
regardless of what the UI shows.

## Non-Functional Requirements

### Security

1. THE Authorization_Service SHALL enforce all permission checks on the server.
2. THE system SHALL never grant access based on client-supplied role or permission data.
3. THE system SHALL send only the user's Effective Permission codes to the client, not raw role/permission internals.

### Maintainability

1. THE authorization model SHALL be data-driven; adding a role SHALL NOT require code changes.
2. THE seed data (roles, permissions, mapping) SHALL be applied via the existing `db:seed` command, not hardcoded in request-handling logic.

## Out of Scope

1. Multi-role per user. One user has at most one role in this phase.
2. An `UPDATE`/edit action for ACL Policies or Routes (only `SHOW`, `ADD`, `DELETE` exist).
3. Per-record / row-level permissions. Permissions are feature + action, not per-resource.
4. A UI for editing roles and permission mappings (managed via seed/data for now).
5. Permission-gating the Dashboard or Log Trail (both remain open to all authenticated users).
