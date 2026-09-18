# Requirements Document

## Introduction

NetOps Policy Manager is a lightweight internal web application for authoring, reviewing, and auditing network Access Control List (ACL) and route policies. It provides authenticated, role-based management of users, ACL policies, and routes, and generates vendor-agnostic device command previews without executing anything against live network devices.

The system is built with TypeScript (strict), Nuxt + Vue 3 + Nitro, Tailwind + Nuxt UI, Zod, Drizzle ORM with PostgreSQL, Argon2-based password hashing, hash-only server-side sessions, a NetOps-managed TOTP second factor, and Vitest, and is packaged as a single multi-stage Docker image. It is intentionally scoped to policy authoring and previewing: it never pushes configuration to routers, firewalls, or switches, and it never provisions its own database.

Authentication supports two account origins (`auth_provider`): **LOCAL** accounts (email + Argon2 password) and **AD** accounts (verified against Active Directory via an LDAP bind). Both origins share the same NetOps-managed TOTP second factor and the same session issuance. The Active Directory provider, its provisioning, routing, and error handling are specified in the dedicated **Active Directory Authentication** spec (`.kiro/specs/ad-authentication/`); this document defines the authentication guarantees the rest of the system depends on.

This document defines the functional requirements (grouped by capability area), non-functional requirements, and explicit out-of-scope boundaries.

## Glossary

- **NetOps_Policy_Manager**: The complete web application system described in this document.
- **Auth_Service**: The server-side component responsible for first-factor verification (LOCAL password or AD bind), MFA challenge issuance, session issuance, and session validation.
- **Auth_Provider**: The persisted origin of an account: `LOCAL` (email + Argon2 password) or `AD` (Active Directory bind). Stored on `users.auth_provider`.
- **First_Factor**: Identity + password verification. For LOCAL accounts this is an Argon2 password check; for AD accounts it is an LDAP bind against Active Directory.
- **MFA_Service**: The server-side component that manages TOTP enrollment and verification (the second factor), shared by all account origins.
- **MFA_Challenge**: A short-lived, signed pre-auth token (carried in a cookie) issued after a successful First_Factor, bearing the user id and a purpose (`MFA_ENROLLMENT` or `MFA_LOGIN`). A session is created only after the second factor tied to this challenge succeeds.
- **Session_Store**: The server-side persistence of active sessions, storing only the hash of each session token.
- **Authorization_Service**: The server-side component that evaluates permissions against roles via `hasPermission()` and `requirePermission()`.
- **User_Admin_Service**: The server-side component that manages user accounts.
- **ACL_Service**: The server-side component that manages ACL policies.
- **Route_Service**: The server-side component that manages route policies.
- **AclCommandGenerator**: A server-side abstraction that generates a device command preview string for an ACL policy.
- **RouteCommandGenerator**: A server-side abstraction that generates a device command preview string for a route policy.
- **Validation_Layer**: The set of reusable Zod schemas used to validate network-related input.
- **Audit_Service**: The server-side component that records audit trail entries.
- **Dashboard_Service**: The server-side component that provides aggregate summary metrics.
- **Data_Layer**: The Drizzle ORM schema and query layer backed by PostgreSQL.
- **API_Layer**: The Nitro server routes exposing HTTP endpoints under `/api`.
- **Frontend**: The Nuxt/Vue 3 client application.
- **Config_Service**: The server-side component that validates environment configuration at startup.
- **Permission**: A named capability defined as a `feature` + `action` pair (e.g. `ACL_POLICIES` + `ADD`), persisted in the `permissions` table.
- **Role**: A named grouping of Permissions, persisted in the `roles` table and mapped to Permissions via `roles_permissions`. A user is associated with at most one Role via `users.role_id`. Roles are data, not hardcoded identifiers.
- **Session_Token**: A raw, high-entropy token issued to the client and stored client-side only in an HttpOnly cookie.
- **Server_Controlled_Field**: A field whose value is set exclusively by the server: `id`, `generatedCommand`, `createdBy`, `createdAt`, `updatedBy`, `updatedAt`.
- **API_Envelope**: The standard response shape `{success:true,data}` on success or `{success:false,error:{code,message,fields?}}` on failure.
- **Production_Environment**: A runtime where `NODE_ENV` equals `production`.

## Requirements

### Requirement 1: Authentication

**User Story:** As an operator, I want to log in with my email (or directory identifier) and password, complete a TOTP second factor, and maintain a secure server-side session, so that only verified individuals with a second factor can access the application.

Authentication is a two-step flow. The **first factor** verifies identity and password — against an Argon2 hash for LOCAL accounts, or against Active Directory via an LDAP bind for AD accounts. The **second factor** is a NetOps-managed TOTP code. A session is created only after the second factor succeeds. The AD first factor, provider routing, provisioning, and directory error handling are specified in the **Active Directory Authentication** spec (`.kiro/specs/ad-authentication/`).

#### Acceptance Criteria

1. WHEN a client sends a valid identifier and password to `POST /api/auth/login`, THE Auth_Service SHALL verify the First_Factor — an Argon2 password check for a LOCAL account, or an Active Directory bind for an AD account — and SHALL NOT create a session at this step.
2. WHEN the First_Factor succeeds for a user who has no confirmed MFA device, THE Auth_Service SHALL issue an MFA_Challenge with purpose `MFA_ENROLLMENT` and SHALL return the status `MFA_SETUP_REQUIRED`.
3. WHEN the First_Factor succeeds for a user who has a confirmed MFA device, THE Auth_Service SHALL issue an MFA_Challenge with purpose `MFA_LOGIN` and SHALL return the status `MFA_REQUIRED`.
4. WHEN a client presents a valid `MFA_ENROLLMENT` challenge to the MFA setup endpoints, THE MFA_Service SHALL allow the user to enroll a TOTP device and confirm it with a valid code before any session is created.
5. WHEN a client sends a valid TOTP code with a valid `MFA_LOGIN` challenge to `POST /api/auth/mfa/verify`, THE Auth_Service SHALL create a session and return the status `AUTHENTICATED` with the user identity.
6. IF a client presents a TOTP code with no valid MFA_Challenge, an expired challenge, or an incorrect code, THEN THE Auth_Service SHALL reject the request with HTTP status 401 and SHALL NOT create a session.
7. WHEN the Auth_Service creates a session, THE Auth_Service SHALL set the raw Session_Token in an HttpOnly, SameSite cookie, and THE Session_Store SHALL persist only a hash of the Session_Token, never the raw token.
8. WHERE the runtime is a Production_Environment, THE Auth_Service SHALL set the Secure attribute on the session cookie.
9. WHEN the Auth_Service creates a session, THE Session_Store SHALL record an expiry timestamp and a last-used timestamp, and WHEN an authenticated request is validated THE Auth_Service SHALL update the last-used timestamp.
10. IF a request presents a Session_Token whose corresponding session is expired, THEN THE Auth_Service SHALL reject the request with HTTP status 401.
11. WHEN a client sends `POST /api/auth/logout` with a valid session, THE Auth_Service SHALL invalidate the corresponding session in the Session_Store.
12. WHEN a client sends `GET /api/auth/me` with a valid session, THE Auth_Service SHALL return the authenticated user identity and permissions in the API_Envelope.
13. IF a login attempt fails due to an unknown identifier or incorrect password, THEN THE Auth_Service SHALL reject the request with HTTP status 401 using a generic invalid-credentials message and SHALL record a LOGIN_FAILED audit entry.
14. IF a login identifier matches an existing user whose `is_active` is false, THEN THE Auth_Service SHALL reject the attempt before any first-factor verification with a distinct account-disabled error, and for an AD account SHALL do so before contacting Active Directory.
15. WHEN a login attempt fully succeeds (first and second factor), THE Audit_Service SHALL record a LOGIN_SUCCESS audit entry.
16. THE Auth_Service SHALL store passwords only for LOCAL accounts as Argon2 hashes, SHALL leave `password_hash` null for AD accounts, and SHALL never persist any AD user's directory password.

### Requirement 2: Authorization and Role-Based Access Control

**User Story:** As a security administrator, I want every protected action gated by server-side permission checks driven by data, so that access control cannot be bypassed by the client and new roles can be introduced without code changes.

> Detailed acceptance criteria for the data-driven RBAC model (role/permission/mapping schema, initial data, and future-role support) live in the dedicated **RBAC & Permissions** spec (`.kiro/specs/rbac-permissions/`). This requirement states the system-level guarantees the rest of NetOps Policy Manager depends on.

#### Acceptance Criteria

1. THE Authorization_Service SHALL derive roles, permissions, and their mapping from persisted data (the `roles`, `permissions`, and `roles_permissions` tables) rather than from hardcoded role identifiers.
2. THE Authorization_Service SHALL model each Permission as a `feature` + `action` pair, covering at minimum the features `ACL_POLICIES`, `ROUTES`, and `ADMINISTRATION` with the actions `SHOW`, `ADD`, and `DELETE` for `ACL_POLICIES` and `ROUTES`, and `SHOW` and `MANAGE` for `ADMINISTRATION`.
3. THE Authorization_Service SHALL associate each user with at most one Role via `users.role_id`, and SHALL treat a user whose `role_id` is null as holding no feature Permissions.
4. THE Authorization_Service SHALL resolve a user's effective Permissions by joining the user's Role to its mapped Permissions, and SHALL expose `hasPermission()` and `requirePermission()` that evaluate those resolved Permissions.
5. IF a request to a protected endpoint has no valid session, THEN THE API_Layer SHALL reject the request with HTTP status 401.
6. IF a request to a protected endpoint has a valid session but the user lacks the required Permission, THEN THE API_Layer SHALL reject the request with HTTP status 403.
7. WHERE a Permission determines visibility of a menu or button, THE Frontend SHALL hide or disable that menu or button for users lacking the Permission.
8. THE API_Layer SHALL enforce every Permission check on the server independently of any Frontend behavior.
9. THE Authorization_Service SHALL NOT hardcode authorization decisions against specific role identifiers (e.g. `role === 'NOC'`); all decisions SHALL be based on resolved Permissions.
10. THE Dashboard and Log Trail SHALL be accessible to every authenticated user and SHALL NOT require any feature Permission.

### Requirement 3: User Administration

**User Story:** As an administrator, I want to manage user accounts and their roles, so that I can control who uses the system and what they can do.

#### Acceptance Criteria

1. WHEN a user holding `ADMINISTRATION_SHOW` requests the user list, THE User_Admin_Service SHALL return a paginated list of users supporting a search filter.
2. WHEN a user holding `ADMINISTRATION_MANAGE` submits data validated by `CreateUserSchema`, THE User_Admin_Service SHALL create a new user account.
3. WHEN a user holding `ADMINISTRATION_MANAGE` submits data validated by `UpdateUserSchema`, THE User_Admin_Service SHALL update the target user's basic information.
4. WHEN a user holding `ADMINISTRATION_MANAGE` submits data validated by `ChangeUserRoleSchema`, THE User_Admin_Service SHALL change the target user's Role and SHALL record a USER_ROLE_CHANGED audit entry.
5. WHEN a user holding `ADMINISTRATION_MANAGE` activates or deactivates a target user, THE User_Admin_Service SHALL update the target user's active status and SHALL record a USER_STATUS_CHANGED audit entry.
6. WHEN a user holding `ADMINISTRATION_MANAGE` submits data validated by `ResetPasswordSchema`, THE User_Admin_Service SHALL store a new Argon2 password hash for the target user.
7. WHEN the User_Admin_Service returns user data validated by `UserResponseSchema`, THE User_Admin_Service SHALL exclude the password, password hash, and any Session_Token.
8. WHEN a user is created, THE Audit_Service SHALL record a USER_CREATED audit entry.
9. WHEN a user's basic information is updated, THE Audit_Service SHALL record a USER_UPDATED audit entry.
10. WHEN a user holding `ADMINISTRATION_MANAGE` changes a target user's Role, THE User_Admin_Service SHALL assign exactly one Role by setting `users.role_id`.

### Requirement 4: ACL Policy Management

**User Story:** As a network engineer, I want to create and manage ACL policies with validated fields and a generated command preview, so that I can author correct access rules for review.

#### Acceptance Criteria

1. WHEN a user holding `ACL_READ` requests the ACL list, THE ACL_Service SHALL return a paginated list supporting search and filtering.
2. WHEN a user holding `ACL_READ` requests an ACL by id, THE ACL_Service SHALL return the matching ACL policy.
3. WHEN a user holding `ACL_CREATE` submits a valid ACL policy via `POST`, THE ACL_Service SHALL create the ACL policy with fields name, source, destination, protocol, port, action, time start, time end, change_ticket, description, and status.
4. THE ACL_Service SHALL accept protocol values of `TCP`, `UDP`, `ICMP`, and `ANY`.
5. WHERE the protocol is `TCP` or `UDP`, THE Validation_Layer SHALL require a port within the range 1 to 65535 inclusive.
6. WHERE the protocol is `ICMP`, THE Validation_Layer SHALL reject any supplied port.
7. THE ACL_Service SHALL accept action values of `ALLOW` and `DENY`.
8. THE ACL_Service SHALL accept status values of `DRAFT`, `ACTIVE`, and `DISABLED`.
9. WHEN a user holding `ACL_UPDATE` submits a valid update via `PATCH`, THE ACL_Service SHALL apply the changes to the target ACL policy.
10. WHEN a user holding `ACL_DELETE` requests deletion via `DELETE`, THE ACL_Service SHALL remove the target ACL policy.
11. WHEN an ACL policy is created or updated, THE AclCommandGenerator SHALL generate a device command preview and THE ACL_Service SHALL store it in the `generatedCommand` field.
12. IF a client request attempts to set any Server_Controlled_Field on an ACL policy, THEN THE ACL_Service SHALL ignore the client-supplied value for that field.
13. WHEN an ACL policy is created, THE Audit_Service SHALL record an ACL_CREATED audit entry within the same database transaction as the creation.
14. WHEN an ACL policy is updated, THE Audit_Service SHALL record an ACL_UPDATED audit entry within the same database transaction as the update.
15. WHEN an ACL policy is deleted, THE Audit_Service SHALL record an ACL_DELETED audit entry within the same database transaction as the deletion.

### Requirement 5: Network Input Validation

**User Story:** As a network engineer, I want strict, reusable validation for network fields, so that only well-formed policy data enters the system.

#### Acceptance Criteria

1. THE Validation_Layer SHALL provide the reusable Zod schemas `IpAddressSchema`, `Ipv4Schema`, `CidrSchema`, `PortSchema`, `ProtocolSchema`, `TimeSchema`, and `ChangeTicketSchema`.
2. WHEN input is validated by `Ipv4Schema`, THE Validation_Layer SHALL accept a syntactically valid IPv4 address and SHALL reject any other value.
3. WHEN input is validated by `CidrSchema`, THE Validation_Layer SHALL accept a syntactically valid CIDR notation value and SHALL reject any other value.
4. WHERE IPv6 input is reasonable for a field, THE Validation_Layer SHALL accept a syntactically valid IPv6 address via `IpAddressSchema`.
5. WHEN input is validated by `PortSchema`, THE Validation_Layer SHALL accept an integer within the range 1 to 65535 inclusive and SHALL reject any value outside that range.
6. WHEN input is validated by `ProtocolSchema`, THE Validation_Layer SHALL accept only `TCP`, `UDP`, `ICMP`, and `ANY`.
7. WHEN input is validated by `TimeSchema`, THE Validation_Layer SHALL accept a well-formed time value and SHALL reject a malformed time value.
8. WHEN input is validated by `ChangeTicketSchema`, THE Validation_Layer SHALL accept a well-formed change ticket reference and SHALL reject a malformed reference.
9. WHEN any Validation_Layer schema receives an empty string for a required field, THE Validation_Layer SHALL reject the empty string.
10. THE Validation_Layer SHALL enforce a maximum length constraint on description fields.

### Requirement 6: Route Management

**User Story:** As a network engineer, I want to create and manage route policies with a generated command preview, so that I can author routing changes for review.

#### Acceptance Criteria

1. WHEN a user holding `ROUTE_READ` requests the route list, THE Route_Service SHALL return a paginated list supporting search and filtering.
2. WHEN a user holding `ROUTE_READ` requests a route by id, THE Route_Service SHALL return the matching route policy.
3. WHEN a user holding `ROUTE_CREATE` submits a valid route via `POST`, THE Route_Service SHALL create the route with fields name, destination CIDR, source, next_hop, policy, time start, time end, change_ticket, and status.
4. WHEN input for the destination field is validated, THE Validation_Layer SHALL require valid CIDR notation.
5. WHEN input for the next_hop field is validated, THE Validation_Layer SHALL require a valid IP address and SHALL reject an invalid next hop.
6. WHEN a user holding `ROUTE_UPDATE` submits a valid update via `PATCH`, THE Route_Service SHALL apply the changes to the target route.
7. WHEN a user holding `ROUTE_DELETE` requests deletion via `DELETE`, THE Route_Service SHALL remove the target route.
8. WHEN a route is created or updated, THE RouteCommandGenerator SHALL generate a device command preview and THE Route_Service SHALL store it in the `generatedCommand` field.
9. IF a client request attempts to set any Server_Controlled_Field on a route, THEN THE Route_Service SHALL ignore the client-supplied value for that field.
10. WHEN a route is created, THE Audit_Service SHALL record a ROUTE_CREATED audit entry within the same database transaction as the creation.
11. WHEN a route is updated, THE Audit_Service SHALL record a ROUTE_UPDATED audit entry within the same database transaction as the update.
12. WHEN a route is deleted, THE Audit_Service SHALL record a ROUTE_DELETED audit entry within the same database transaction as the deletion.

### Requirement 7: Command Generation

**User Story:** As a network engineer, I want vendor-agnostic command previews generated on the server, so that I can review the intended device configuration without any device execution.

#### Acceptance Criteria

1. THE AclCommandGenerator SHALL execute exclusively on the server.
2. THE RouteCommandGenerator SHALL execute exclusively on the server.
3. THE AclCommandGenerator and THE RouteCommandGenerator SHALL produce command previews only and SHALL NOT execute commands against any network device.
4. THE AclCommandGenerator and THE RouteCommandGenerator SHALL be defined as abstractions that allow vendor-specific implementations to be swapped without changing the domain model.
5. THE NetOps_Policy_Manager domain model SHALL remain independent of any single vendor command syntax.
6. WHERE a future adapter directory `server/network/` is introduced, THE NetOps_Policy_Manager SHALL treat it as a boundary for vendor adapters and SHALL NOT include simulated device connections.

### Requirement 8: Audit Trail

**User Story:** As a compliance auditor, I want a tamper-resistant record of all significant actions, so that I can review and export the history of changes.

#### Acceptance Criteria

1. THE Audit_Service SHALL record audit entries for the activities LOGIN_SUCCESS, LOGIN_FAILED, LOGOUT, USER_CREATED, USER_UPDATED, USER_ROLE_CHANGED, USER_STATUS_CHANGED, ACL_CREATED, ACL_UPDATED, ACL_DELETED, ROUTE_CREATED, ROUTE_UPDATED, and ROUTE_DELETED.
2. THE Data_Layer SHALL store each audit entry with before_state, after_state, and metadata fields typed as JSONB.
3. THE Audit_Service SHALL exclude passwords, password hashes, Session_Tokens, cookie values, authorization headers, the DATABASE_URL value, and any secret from every audit entry.
4. WHEN a mutation that requires auditing succeeds, THE Audit_Service SHALL write the corresponding audit entry within the same database transaction as the mutation.
5. IF the audit write within a mutation transaction fails, THEN THE Data_Layer SHALL roll back the mutation.
6. THE API_Layer SHALL NOT expose any endpoint that deletes audit entries during normal operation.
7. WHEN any authenticated user opens the `/logs` (Log Trail) page, THE Frontend SHALL provide search, date filtering, activity filtering, result filtering, and pagination.
8. WHEN any authenticated user selects an audit entry, THE Frontend SHALL display a detail view of that entry.
9. WHEN any authenticated user requests an export, THE Audit_Service SHALL produce an export of the selected audit entries.
10. THE Log Trail SHALL be available to every authenticated user and SHALL NOT require a feature Permission.

### Requirement 9: Dashboard

**User Story:** As an operator, I want a lightweight summary dashboard, so that I can see key counts and recent activity at a glance.

#### Acceptance Criteria

1. WHEN an authenticated user opens the dashboard, THE Dashboard_Service SHALL return the total count of ACL policies.
2. WHEN an authenticated user opens the dashboard, THE Dashboard_Service SHALL return the count of ACL policies with status `ACTIVE`.
3. WHEN an authenticated user opens the dashboard, THE Dashboard_Service SHALL return the total count of routes.
4. WHEN an authenticated user opens the dashboard, THE Dashboard_Service SHALL return the count of routes with status `ACTIVE`.
5. WHEN an authenticated user opens the dashboard, THE Dashboard_Service SHALL return a list of recent activities.
6. THE Dashboard_Service SHALL present summary metrics without complex chart rendering.

### Requirement 10: Data Model and Persistence

**User Story:** As a developer, I want a well-constrained relational schema with parameterized queries, so that data integrity and query safety are guaranteed.

#### Acceptance Criteria

1. THE Data_Layer SHALL define Drizzle schemas for the tables users, roles, permissions, roles_permissions, sessions, user_mfa, acl_policies, routes, and audit_logs.
2. THE Data_Layer SHALL use UUID values as primary key identifiers.
3. THE Data_Layer SHALL enforce a unique constraint on the users email column, and a unique constraint on the users external_id column for directory-provisioned accounts.
4. THE Data_Layer SHALL define foreign key constraints between related tables.
5. THE Data_Layer SHALL prevent duplicate Permission assignments for the same Role via a unique constraint on `roles_permissions(role_id, permission_id)`.
6. THE Data_Layer SHALL define indexes on user email, user role_id, session token hash, session user, ACL name, ACL status, change_ticket, route destination, route status, audit timestamp, audit actor, and audit activity.
7. THE Data_Layer SHALL execute all queries as parameterized Drizzle queries.

### Requirement 11: Application Schema Layering

**User Story:** As a developer, I want separate, explicit model layers derived from Zod, so that database rows are never exposed and mass-assignment is prevented.

#### Acceptance Criteria

1. THE NetOps_Policy_Manager SHALL define separate models for the Database layer, Domain layer, API Request layer, API Response layer, and UI Form layer.
2. THE NetOps_Policy_Manager SHALL derive application types from Zod schemas using `z.infer`.
3. THE API_Layer SHALL NOT return raw Database rows to the Frontend.
4. THE API_Layer SHALL accept mutation input only through explicit API Request schemas that exclude Server_Controlled_Fields.

### Requirement 12: API Contract and Error Handling

**User Story:** As a client developer, I want a consistent response envelope and safe error handling, so that I can rely on predictable responses without leaking sensitive details.

#### Acceptance Criteria

1. WHEN a request succeeds, THE API_Layer SHALL respond with the API_Envelope shape `{success:true,data}`.
2. WHEN a request fails, THE API_Layer SHALL respond with the API_Envelope shape `{success:false,error:{code,message,fields?}}`.
3. WHEN input validation fails, THE API_Layer SHALL populate the error `fields` property with the offending field details.
4. IF an internal error occurs, THEN THE API_Layer SHALL exclude database error text, SQL, stack traces, filesystem paths, and secrets from the client response.
5. WHEN an internal error occurs, THE API_Layer SHALL log the error detail on the server only.
6. WHEN a client requests any list resource, THE API_Layer SHALL apply server-side pagination.

### Requirement 13: UX States, Accessibility, and Visual Theme

**User Story:** As an operator, I want clear interface states, accessible controls, and a consistent light visual theme, so that I can use the application reliably even when errors occur and the interface never renders inconsistent dark surfaces.

#### Acceptance Criteria

1. THE Frontend SHALL provide loading, empty, and error states for every data page.
2. IF an API request for a data page fails, THEN THE Frontend SHALL display an error state rather than a blank screen.
3. WHEN a user initiates a destructive action of delete, disable, or password reset, THE Frontend SHALL present a confirmation interface before proceeding.
4. THE Frontend SHALL validate form input using shared Zod schemas.
5. WHEN the Frontend submits validated input, THE API_Layer SHALL re-validate the input on the server.
6. THE Frontend SHALL provide form labels, semantic button controls, readable validation error messages, and keyboard navigation for interactive controls.
7. THE Frontend SHALL present a single light visual theme and SHALL NOT expose a dark-mode toggle.
8. THE Frontend SHALL render all Nuxt UI components and overlays — including modals, dropdowns, selects, inputs, badges, and tables — using the NetOps light design tokens, regardless of the operating system or browser color-scheme preference.
9. WHERE a stray dark color-mode class, a stale stored color-mode value, or an operating-system dark preference is present, THE Frontend SHALL still render surfaces, text, and borders in the light theme.
10. THE Frontend SHALL render native browser chrome — including scrollbars and form controls — in a light appearance consistent with the light theme, including within scrollable overlays such as the Profile modal.
11. THE Frontend SHALL define the light-theme token mapping, forced light color-scheme, and scrollbar styling as global styles in the single Tailwind stylesheet, and SHALL NOT rely on per-component dark-mode overrides to achieve the light appearance.

### Requirement 14: Configuration and Environment

**User Story:** As an operator, I want validated environment configuration and no implicit database provisioning, so that deployment behavior is explicit and safe.

#### Acceptance Criteria

1. THE NetOps_Policy_Manager SHALL provide a `.env.example` file containing placeholder entries — without real credentials — for at least `NODE_ENV`, `DATABASE_URL`, `SESSION_SECRET`, `MFA_ENCRYPTION_KEY`, `SESSION_TTL_HOURS`, `MFA_CHALLENGE_TTL_MINUTES`, the seed-user variables, and the Active Directory variables (`AD_ENABLED`, `AUTH_LOCAL_ENABLED`, `AD_URL`, `AD_BASE_DN`, `AD_BIND_DN`, `AD_BIND_PASSWORD`, and any AD timeout/discovery flags) as specified in the Active Directory Authentication spec.
2. WHEN the application starts, THE Config_Service SHALL validate the required environment variables with a Zod schema, including the conditional AD variables that become required when `AD_ENABLED` is true.
3. IF a required environment variable is missing or invalid at startup, THEN THE Config_Service SHALL halt startup with an error.
4. THE NetOps_Policy_Manager SHALL NOT create or provision a PostgreSQL database.
5. THE NetOps_Policy_Manager SHALL NOT run database migrations automatically at startup.
6. THE NetOps_Policy_Manager SHALL NOT fall back to SQLite or any embedded database.

### Requirement 15: Migration and Seeding

**User Story:** As an operator, I want explicit migration and seeding commands, so that schema changes and initial data are applied intentionally.

#### Acceptance Criteria

1. THE NetOps_Policy_Manager SHALL provide a `db:generate` command that produces Drizzle migrations.
2. THE NetOps_Policy_Manager SHALL provide a `db:migrate` command that applies Drizzle migrations explicitly.
3. THE NetOps_Policy_Manager SHALL provide a `db:seed` command that seeds the roles `ADMINISTRATOR`, `L2_ENGINEER`, and `NOC`, the initial permission catalog, and the initial role→permission mapping (as specified in the RBAC & Permissions spec).
4. WHEN the `db:seed` command runs in development, THE NetOps_Policy_Manager SHALL create an initial LOCAL admin account using credentials sourced from environment variables and SHALL assign it the `ADMINISTRATOR` role.
5. THE NetOps_Policy_Manager SHALL NOT hardcode the initial admin credentials in source code.
6. WHERE the runtime is a Production_Environment configured for Active-Directory-only authentication, THE NetOps_Policy_Manager SHALL be operable without the seeded LOCAL admin, and the first administrator SHALL be established by an operator assigning the `ADMINISTRATOR` role to an already-provisioned AD user directly in the database, as specified in the Active Directory Authentication spec.

### Requirement 16: Packaging and Deployment

**User Story:** As an operator, I want a single self-contained application image and a health endpoint, so that I can deploy and monitor the app without bundling a database.

#### Acceptance Criteria

1. THE NetOps_Policy_Manager SHALL build as a single multi-stage Docker image tagged `netops-policy-manager:<version>`.
2. THE Docker image SHALL exclude PostgreSQL, database data, `.env` files, `.git` data, development cache, test artifacts, and secrets.
3. THE NetOps_Policy_Manager SHALL NOT include a PostgreSQL container or a docker-compose definition for the database.
4. WHEN a client sends `GET /api/health`, THE API_Layer SHALL respond with `{success:true,data:{status:"healthy"}}`.
5. THE `GET /api/health` response SHALL exclude secrets.

### Requirement 17: Quality Gate

**User Story:** As a maintainer, I want automated tests and a passing build pipeline, so that critical validation and security behaviors are enforced.

#### Acceptance Criteria

1. THE NetOps_Policy_Manager SHALL include Vitest tests that accept a valid IPv4 address and reject an invalid IPv4 address.
2. THE NetOps_Policy_Manager SHALL include Vitest tests that accept a valid CIDR value and reject an invalid CIDR value.
3. THE NetOps_Policy_Manager SHALL include a Vitest test that rejects port value 0.
4. THE NetOps_Policy_Manager SHALL include a Vitest test that rejects port value 65536.
5. THE NetOps_Policy_Manager SHALL include a Vitest test that accepts a valid TCP protocol with a valid port.
6. THE NetOps_Policy_Manager SHALL include a Vitest test that rejects an ICMP protocol combined with a port.
7. THE NetOps_Policy_Manager SHALL include a Vitest test that rejects an invalid next hop value.
8. THE NetOps_Policy_Manager SHALL include a Vitest test that rejects an invalid time value.
9. THE NetOps_Policy_Manager SHALL include a Vitest test that rejects an unauthenticated request to a protected endpoint.
10. THE NetOps_Policy_Manager SHALL include a Vitest test that rejects a request lacking the required Permission.
11. THE NetOps_Policy_Manager SHALL include a Vitest test that confirms a client-supplied `generatedCommand` value is ignored or rejected.
12. THE NetOps_Policy_Manager SHALL include a Vitest test that confirms a client-supplied `createdBy` value is ignored or rejected.
13. THE NetOps_Policy_Manager SHALL include a Vitest test that confirms a password hash never appears in an API response.
14. THE NetOps_Policy_Manager SHALL include a Vitest test that confirms ACL creation produces an audit entry.
15. THE NetOps_Policy_Manager SHALL include a Vitest test that confirms route creation produces an audit entry.
16. THE NetOps_Policy_Manager SHALL pass type checking, linting, the test suite, and a production build.

## Non-Functional Requirements

### Security

1. THE NetOps_Policy_Manager SHALL store LOCAL passwords only as Argon2 hashes, and SHALL never store any AD user's directory password or a hash of it (`password_hash` stays null for AD accounts).
2. THE NetOps_Policy_Manager SHALL store only session token hashes and SHALL keep raw Session_Tokens in HttpOnly cookies.
3. THE NetOps_Policy_Manager SHALL store TOTP secrets only in encrypted form (AES-256-GCM) and SHALL never return a TOTP secret to the client except within the enrollment otpauth URI needed to render the QR code.
4. THE NetOps_Policy_Manager SHALL enforce all authentication and authorization checks on the server.
5. THE NetOps_Policy_Manager SHALL prevent mass-assignment by accepting mutations only through explicit request schemas.
6. THE NetOps_Policy_Manager SHALL exclude secrets, credentials, and sensitive internal details from client responses, audit entries, and the health endpoint.

### Performance and Footprint

1. THE NetOps_Policy_Manager SHALL apply server-side pagination to all list endpoints to bound response size.
2. THE NetOps_Policy_Manager SHALL operate as a lightweight application suitable for a constrained internal server.
3. THE Dashboard_Service SHALL avoid complex chart rendering to minimize client load.

### Maintainability

1. THE NetOps_Policy_Manager SHALL be written in TypeScript with strict type checking enabled.
2. THE NetOps_Policy_Manager SHALL derive application types from Zod schemas to keep validation and types aligned.
3. THE NetOps_Policy_Manager SHALL isolate vendor command syntax behind the AclCommandGenerator and RouteCommandGenerator abstractions.

### Accessibility

1. THE Frontend SHALL provide labeled form controls and semantic buttons.
2. THE Frontend SHALL present readable validation error messages.
3. THE Frontend SHALL support keyboard navigation for interactive controls.

## Out of Scope

The following are explicitly NOT part of NetOps Policy Manager and SHALL NOT be built:

1. Actual configuration of routers, firewalls, or switches.
2. SSH, NETCONF, Ansible, NAPALM, or Netmiko integrations.
3. Configuration push or rollback to network devices.
4. Storage of device credentials.
5. Approval workflow features.
6. ServiceNow or Jira integration.
7. Email or SMS notifications.
8. Message queue integration.
9. Redis or any additional caching datastore.
10. Microservices architecture.
11. Kubernetes orchestration.
12. CI/CD pipeline definitions.
13. Cloud deployment automation.
