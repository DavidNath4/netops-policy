# Requirements Document — User Management (Administration)

## Introduction

This spec is the authoritative document for the **Administration user
management** feature at `/administration`: the paginated user list, editing basic
info, changing a user's role, and activating/deactivating accounts, plus the two
admin "Test Connection" diagnostics that sit on the same page. The feature is
RBAC-gated and emits an audit record for every role/status change.

A **critical current-build fact**: user **creation** and **password reset** are
DISABLED. Accounts are provisioned through Active Directory sign-in (JIT), and
passwords are managed in Active Directory, so the application neither creates
users nor resets passwords. Both the UI control and the server endpoint reject.

Related specs:

- **rbac-permissions/** — `ADMINISTRATION_SHOW` / `ADMINISTRATION_MANAGE`, which gate this page.
- **authentication/** — AD JIT provisioning (how accounts actually come to exist) and the LOCAL/AD provider model.
- **log-trail/** — the `USER`/`UPDATE` audit record emitted by role/status changes.
- **ticketing-itop/** — the authoritative behavior of the two Test Connection buttons that live on this page.
- **general/** — the API envelope and the model-layering (secret-excluding response) rules.

### Scope

In scope: the user list + search + pagination (page size 5), edit basic info,
change role, activate/deactivate, the disabled create / disabled reset-password
posture, the USER/UPDATE audit, the secret-excluding response shape, and the two
Test Connection buttons as they sit on this page. Out of scope: creating users,
resetting passwords, the RBAC catalog itself (see rbac-permissions/), AD sign-in
mechanics (see authentication/), and the Test Connection behavior detail (see
ticketing-itop/).

## Glossary

- **User_Service**: The server component (`server/services/user.service.ts`) orchestrating user administration; roles are resolved by code, and responses never carry secrets.
- **AdminUserResponse**: The safe user shape returned to the Administration client — `userId`, `email`, `displayName`, `roleCode`/`roleName` (nullable), `isActive`, `lastLoginAt`, `createdAt`, `updatedAt`. It carries no password hash, session token, or other secret.
- **canManage**: The client-side flag `can('ADMINISTRATION_MANAGE')` that reveals every mutating control and the Connections diagnostics block.
- **Self_Disable_Guard**: The service rule that refuses to let an admin disable their OWN account, preventing self-lockout.

## Requirements

### Requirement 1: Access control

**User Story:** As a security owner, I want the Administration page gated by permission, so that only authorized admins can view and manage users.

#### Acceptance Criteria

1. THE `/administration` page and the `GET /api/users` list SHALL require `ADMINISTRATION_SHOW`.
2. EVERY mutating user endpoint (`PATCH /api/users/:id`, `PATCH /api/users/:id/role`, `PATCH /api/users/:id/status`) SHALL require `ADMINISTRATION_MANAGE` and SHALL enforce an `assertSameOrigin` check.
3. THE Frontend SHALL reveal mutating controls and the Connections diagnostics block only WHERE `canManage` is true; the server SHALL remain the authoritative gate regardless of the UI.

### Requirement 2: User list, search, and pagination

**User Story:** As an admin, I want a searchable, paged list of users, so that I can find and manage accounts.

#### Acceptance Criteria

1. THE Administration list SHALL display Email, Name, Role, and Status, with per-row actions behind the `canManage` gate.
2. THE client SHALL request a page size of 5 (`ITEMS_PER_PAGE = 5`).
3. THE `GET /api/users` endpoint SHALL accept `page`, `limit`, and `search`, SHALL clamp `limit` to the range [1, 100] (default 20), and SHALL default `page` to 1.
4. THE list SHALL render loading, empty, and error states; the empty state SHALL explain that users are provisioned via Active Directory sign-in.

### Requirement 3: User creation is DISABLED

**User Story:** As a platform owner, I want user creation turned off, so that accounts come only from Active Directory and the local path cannot drift.

#### Acceptance Criteria

1. THE `POST /api/users` endpoint SHALL reject with HTTP `403` / `FORBIDDEN` ("User creation is currently disabled") AFTER its `assertSameOrigin` + `ADMINISTRATION_MANAGE` checks and BEFORE creating anything. *(Confirmed by reading `server/api/users/index.post.ts`: it throws the FORBIDDEN error and never calls `createUser`.)*
2. THE Frontend SHALL hide the "Add User" control (`canCreateUser` is hardwired to `false`), so no create dialog is reachable in the current build.
3. THE route, its authorization, and the `AdminCreateUserSchema` SHALL be retained so the contract stays stable and the feature can be restored later. *(The `createUser` service and `CreateLocalUserSchema`/`AdminCreateUserSchema` remain in the codebase but are not invoked by the handler.)*

### Requirement 4: Password reset is DISABLED

**User Story:** As a platform owner, I want password reset turned off, so that passwords are managed only in Active Directory.

#### Acceptance Criteria

1. THE `POST /api/users/:id/reset-password` endpoint SHALL reject with HTTP `403` / `FORBIDDEN` ("Password reset is disabled; passwords are managed in Active Directory") AFTER its `assertSameOrigin` + `ADMINISTRATION_MANAGE` checks and BEFORE changing anything. *(Confirmed by reading `server/api/users/[id]/reset-password.post.ts`: it throws the FORBIDDEN error and never calls `resetUserPassword`.)*
2. THE Frontend SHALL offer no password-reset control in the current build.
3. THE route and its authorization SHALL be retained so the contract stays stable and the feature can be restored later.

### Requirement 5: Edit basic info

**User Story:** As an admin, I want to update a user's display name, so that account details stay accurate.

#### Acceptance Criteria

1. THE `PATCH /api/users/:id` endpoint SHALL accept `AdminUpdateUserSchema` (`displayName`, trimmed, 1..150 chars) and SHALL update only the display name.
2. IF the target user does not exist, THEN THE endpoint SHALL respond with `NOT_FOUND`.
3. THE endpoint SHALL return the updated `AdminUserResponse` (no secrets).

### Requirement 6: Change role

**User Story:** As an admin, I want to change a user's single role, so that their effective permissions match their duties.

#### Acceptance Criteria

1. THE `PATCH /api/users/:id/role` endpoint SHALL accept `AdminChangeRoleSchema` (`roleCode`) and SHALL set the user's single `role_id` to the role resolved from that code.
2. IF the role code does not map to a role, THEN THE endpoint SHALL respond with `VALIDATION_ERROR` ("Unknown role").
3. WHEN the role change is attempted, THE User_Service SHALL record a `USER`/`UPDATE` audit row with `kind = 'ROLE_CHANGE'`, `fromRole`, and `toRole` in the payload (SUCCESS on success, FAILED on an unknown user/role) — see log-trail/.
4. THE endpoint SHALL return the updated `AdminUserResponse`.

### Requirement 7: Activate / deactivate

**User Story:** As an admin, I want to enable or disable an account, so that I can control who may sign in.

#### Acceptance Criteria

1. THE `PATCH /api/users/:id/status` endpoint SHALL accept `AdminSetStatusSchema` (`isActive`) and SHALL set the user's active flag.
2. IF an admin attempts to disable their OWN account, THEN THE endpoint SHALL reject with `SELF_DISABLE_FORBIDDEN` (HTTP `400`) and SHALL NOT change the status.
3. WHEN the status change is attempted, THE User_Service SHALL record a `USER`/`UPDATE` audit row with `kind = 'STATUS_CHANGE'`, `targetUserId`, `targetUsername`, and `isActive` in the payload (SUCCESS or FAILED) — see log-trail/.
4. THE Frontend SHALL hide the self-disable action and SHALL confirm a disable (a destructive action) before calling the endpoint.

### Requirement 8: The two Test Connection buttons

**User Story:** As an admin, I want to test iTop and n8n connectivity from the Administration page, so that I can diagnose integration issues in one place.

#### Acceptance Criteria

1. THE Administration page SHALL present a "Connections" block with "Test iTop Connection" and "Test n8n Connection" buttons, visible only WHERE `canManage` is true.
2. THE buttons SHALL call `POST /api/itop/test` and `POST /api/n8n/test`; the authoritative behavior and authorization of those endpoints is documented in ticketing-itop/.

## Non-Functional Requirements

### Security

1. THE User_Service SHALL return only the `AdminUserResponse` shape and SHALL NEVER expose a password hash, session token, or any secret.
2. EVERY mutating endpoint SHALL enforce `assertSameOrigin` plus `ADMINISTRATION_MANAGE` on the server, independent of UI gating.

### Auditability

1. EVERY role and status change SHALL emit a best-effort `USER`/`UPDATE` audit row (see log-trail/); an audit-write failure SHALL NOT alter the HTTP response.
