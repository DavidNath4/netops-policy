# Requirements Document — RBAC & Permissions

## Introduction

This spec defines the **data-driven Role-Based Access Control (RBAC)** model for NetOps Policy Manager. It replaces the earlier hardcoded role→permission mapping. Authorization is now decided entirely from persisted data — roles, permissions, and their mapping live in the database — so new roles can be introduced by inserting data, never by changing code.

Scope of this spec:

- The master role table, the permission catalog (feature + action), and the role→permission mapping.
- The `users.role_id` association (one role per user for now).
- The initial roles, initial permissions, and initial mapping.
- Server-side enforcement based on resolved permissions, and frontend menu/button gating.
- Constraints and future-role support.

This is a sub-spec of NetOps Policy Manager. Where it intersects the main spec, the main `requirements.md`/`design.md` have been updated to reference this document.

## Glossary

- **Role**: A named grouping of Permissions, persisted in `roles`. Identified logically by `role_code`. A user has at most one Role.
- **Permission**: A capability defined as a `feature` + `action` pair, persisted in `permissions` and referenced in code by `permission_code` = `<FEATURE>_<ACTION>`.
- **Feature**: A gated area of the product: `ACL_POLICIES`, `ROUTES`, `ADMINISTRATION`.
- **Action**: An operation within a feature: `SHOW`, `ADD`, `DELETE` (and `MANAGE` for `ADMINISTRATION`).
- **Role→Permission mapping**: Rows in `roles_permissions` that grant a Permission to a Role.
- **Effective Permissions**: The set of `permission_code` values resolved for a user by joining the user's active Role to its active mapped Permissions.
- **Authorization_Service**: The server component that resolves and enforces Effective Permissions.

## Requirements

### Requirement 1: Role catalog

**User Story:** As a security administrator, I want roles stored as data, so that roles can be added or retired without code changes.

#### Acceptance Criteria

1. THE Data_Layer SHALL persist roles in a `roles` table with `role_id` (UUID PK), `role_code` (unique, not null), `role_name` (not null), `description` (nullable), `is_active` (not null, default true), `created_at`, and `updated_at`.
2. THE Data_Layer SHALL enforce a unique constraint on `roles.role_code`.
3. THE system SHALL seed the initial roles `ADMINISTRATOR`, `L2_ENGINEER`, and `NOC`.
4. THE Authorization_Service SHALL treat a role with `is_active = false` as granting no Permissions.
5. THE system SHALL NOT hardcode role identifiers in authorization logic (e.g. `role === 'NOC'`).

### Requirement 2: Permission catalog

**User Story:** As a security administrator, I want permissions expressed as feature + action, so that access maps directly to product capabilities.

#### Acceptance Criteria

1. THE Data_Layer SHALL persist permissions in a `permissions` table with `permission_id` (UUID PK), `permission_code` (unique, not null), `feature` (not null), `action` (not null), `description` (nullable), `is_active` (not null, default true), `created_at`, and `updated_at`.
2. THE Data_Layer SHALL enforce a unique constraint on `permissions.permission_code` and a unique constraint on the pair (`feature`, `action`).
3. THE system SHALL seed the initial permissions: `ACL_POLICIES_SHOW`, `ACL_POLICIES_ADD`, `ACL_POLICIES_DELETE`, `ROUTES_SHOW`, `ROUTES_ADD`, `ROUTES_DELETE`, `ADMINISTRATION_SHOW`, and `ADMINISTRATION_MANAGE`.
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

1. THE Data_Layer SHALL add a nullable `role_id` column to the `users` table as a foreign key to `roles.role_id`.
2. THE `users.role_id` foreign key SHALL use `ON DELETE RESTRICT`, so a role that is still assigned to any user cannot be deleted.
3. THE Authorization_Service SHALL treat a user whose `role_id` is null as holding no feature Permissions.
4. WHEN an administrator changes a user's role, THE system SHALL set `users.role_id` to exactly one role.
5. THE system SHALL support retiring a role by setting `roles.is_active = false` rather than deleting it while users are assigned.

### Requirement 5: Permission resolution and enforcement

**User Story:** As a security administrator, I want every protected action checked against the user's resolved permissions on the server, so that access cannot be bypassed by the client.

#### Acceptance Criteria

1. THE Authorization_Service SHALL resolve a user's Effective Permissions by joining `users.role_id` → `roles` (active) → `roles_permissions` → `permissions` (active).
2. THE Authorization_Service SHALL expose `hasPermission(auth, code)` and `requirePermission(event, code)` that evaluate Effective Permissions.
3. IF a request to a protected endpoint has no valid session, THEN THE API_Layer SHALL reject it with HTTP status 401.
4. IF a request to a protected endpoint has a valid session but the resolved permissions do not include the required Permission, THEN THE API_Layer SHALL reject it with HTTP status 403.
5. THE API_Layer SHALL enforce the Permission check on the server independently of any Frontend behavior.
6. THE Authorization_Service SHALL base every authorization decision on Effective Permissions and SHALL NOT branch on specific role identifiers.
7. THE `GET /api/auth/me` response SHALL include the authenticated user's Effective Permissions so the Frontend can gate menus and buttons.

### Requirement 6: Feature-to-permission gating

**User Story:** As an operator, I want to see only the menus and actions I'm allowed to use, so that the interface matches my access.

#### Acceptance Criteria

1. THE Frontend SHALL gate the ACL Policies list/detail view behind `ACL_POLICIES_SHOW`, the ACL create action behind `ACL_POLICIES_ADD`, and the ACL delete action behind `ACL_POLICIES_DELETE`.
2. THE Frontend SHALL gate the Routes list/detail view behind `ROUTES_SHOW`, the Route create action behind `ROUTES_ADD`, and the Route delete action behind `ROUTES_DELETE`.
3. THE Frontend SHALL gate the Administration menu/view behind `ADMINISTRATION_SHOW` and the user-management actions behind `ADMINISTRATION_MANAGE`.
4. THE Frontend SHALL always show the Dashboard and Log Trail menus to every authenticated user, without requiring any Permission.
5. WHERE a user lacks the Permission for a menu or action, THE Frontend SHALL hide or disable it, and THE server SHALL still re-enforce the Permission on the corresponding request.

### Requirement 7: Future-role support

**User Story:** As a security administrator, I want to introduce new roles later, so that access policy can evolve without database migrations or code changes.

#### Acceptance Criteria

1. THE schema SHALL allow a new role to be created by inserting a `roles` row and the desired `roles_permissions` rows, with no schema change and no code change.
2. THE schema SHALL allow any combination of existing Permissions to be granted to any role (for example, a future role granted `ACL_POLICIES_SHOW/ADD/DELETE` and `ROUTES_SHOW/ADD/DELETE`).
3. WHEN a new Permission (feature or action) is genuinely required, THE change SHALL be limited to adding a `permissions` row (and mapping rows); existing roles SHALL remain unaffected until explicitly mapped.

## Non-Functional Requirements

### Security

1. THE Authorization_Service SHALL enforce all permission checks on the server.
2. THE system SHALL never grant access based on client-supplied role or permission data.
3. THE system SHALL exclude the raw role/permission internals it does not need to expose; only the user's Effective Permission codes are sent to the client.

### Maintainability

1. THE authorization model SHALL be data-driven; adding a role SHALL NOT require code changes.
2. THE seed data (roles, permissions, mapping) SHALL be applied via the existing `db:seed` command, not hardcoded in request-handling logic.

## Out of Scope

1. Multi-role per user (`user_roles`). One user has at most one role in this phase.
2. An `UPDATE`/edit action for ACL Policies or Routes (only `SHOW`, `ADD`, `DELETE` exist now).
3. Per-record / row-level permissions. Permissions are feature+action, not per-resource.
4. A UI for editing roles and permission mappings (managed via seed/data for now).
5. Permission-gating the Dashboard or Log Trail (both remain open to all authenticated users).
