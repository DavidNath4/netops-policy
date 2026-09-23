# Requirements Document

## Introduction

NetOps Policy Manager is a lightweight internal web application that provides an authenticated, role-based **interface and audit/logging center** for network Access Control List (ACL) and route operations. Network engineers submit ACL and route requests (show, add, delete) through this application; the actual execution against network devices is performed by an external **n8n** automation workflow (behind an SSH jump host). This application does not execute commands itself and does not store network device configuration — it validates and captures the operator's intent, shows a redacted command preview for add/delete actions, delegates execution to n8n over an authenticated webhook, waits for the result, and records every request and its outcome as an immutable audit log.

The application's PostgreSQL database is an **audit/logging layer, not the source of truth** for ACL/route state. The live state of ACLs and routes resides on the devices and is reached only through n8n (e.g. read-only `show` commands); this application never persists ACL or route rows of its own.

The system is built with TypeScript (strict), Nuxt + Vue 3 + Nitro, Tailwind + Nuxt UI, Zod, Drizzle ORM with PostgreSQL, Argon2-based password hashing, hash-only server-side sessions, a NetOps-managed TOTP second factor, and Vitest, and is packaged as a single multi-stage Docker image. It is intentionally scoped to being the operator-facing interface and the audit system of record: it never opens SSH/NETCONF sessions to devices itself, never stores device credentials, and never provisions its own database. Command execution is real, but it is owned entirely by n8n; the n8n webhook contract, payload shapes, API-key authentication, correlation id, and command-preview templates are specified in the dedicated **n8n Integration** spec (`.kiro/specs/n8n-integration/`).

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
- **ACL_Service**: The server-side component that validates ACL requests (show/add/delete), builds the redacted command preview, delegates execution to n8n, and records the audit log. It does not persist ACL rows.
- **Route_Service**: The server-side component that does the same for route requests (show/add/delete).
- **N8N_Client**: The server-side component that calls the n8n webhook(s) over HTTP with the API key and the correlation id, sends the field payload, and returns the execution result. It is the only component that talks to n8n.
- **N8N_Executor**: The external n8n automation workflow that receives the field payload, connects to the target device via the SSH jump host, executes the command, and returns the result. Its device credentials live in n8n, never in this application.
- **Command_Preview**: A human-readable, client-facing string showing the command that the operator's input will result in, rendered in a terminal-style box for add/delete actions. It is built from a static command template plus the operator's field values, is redacted (see Redaction), and is display/audit-only — it is NOT the payload sent to n8n.
- **Command_Template**: One of the static (hardcoded) command shapes maintained in this application — one per ACL add, ACL delete, route add, route delete — with placeholders for the dynamic field values. Templates exist for preview only.
- **Execution_Credentials**: The per-engineer username and password the operator supplies on each add/delete/show request, forwarded to n8n so n8n can perform the operation as that engineer. These are distinct from the device SSH credentials configured inside n8n. This application forwards them to n8n but never persists them and never returns them to the client in cleartext.
- **Redaction**: Replacing sensitive values (at minimum the Execution_Credentials username and password) with `***` before a Command_Preview is shown to the client or written to an audit log.
- **Correlation_Id**: A unique identifier generated by this application for every operation and carried unchanged through the whole chain — Web App request → n8n execution → device command → device response — and stored on the audit log, so the full trail of one operation can be linked together.
- **Validation_Layer**: The set of reusable Zod schemas used to validate network-related input on the form and re-validate it on the server.
- **Audit_Service**: The server-side component that records audit trail entries in the `audit_logs` table.
- **Audit_Log**: A single immutable record of one operation (auth, user admin, ACL, route, or n8n execution), holding actor snapshot, module, action, status, request context, and JSONB payloads for the request, the command preview, the n8n execution metadata, and the device response.
- **Dashboard_Service**: The server-side component that provides aggregate activity/execution metrics derived from `audit_logs`.
- **Data_Layer**: The Drizzle ORM schema and query layer backed by PostgreSQL. Its purpose is identity, RBAC, sessions, and audit logging — not ACL/route configuration state.
- **API_Layer**: The Nitro server routes exposing HTTP endpoints under `/api`.
- **Frontend**: The Nuxt/Vue 3 client application.
- **Config_Service**: The server-side component that validates environment configuration at startup.
- **Permission**: A named capability defined as a `feature` + `action` pair (e.g. `ACL_POLICIES` + `ADD`), persisted in the `permissions` table.
- **Role**: A named grouping of Permissions, persisted in the `roles` table and mapped to Permissions via `roles_permissions`. A user is associated with at most one Role via `users.role_id`. Roles are data, not hardcoded identifiers.
- **Session_Token**: A raw, high-entropy token issued to the client and stored client-side only in an HttpOnly cookie.
- **API_Envelope**: The standard response shape `{success:true,data}` on success or `{success:false,error:{code,message,fields?}}` on failure.
- **Production_Environment**: A runtime where `NODE_ENV` equals `production`.

## Requirements

### Requirement 1: Authentication

**User Story:** As an operator, I want to log in with my email (or directory identifier) and password, complete a TOTP second factor, and maintain a secure server-side session, so that only verified individuals with a second factor can access the application.

Authentication is a two-step flow. The **first factor** verifies identity and password — against an Argon2 hash for LOCAL accounts, or against Active Directory via an LDAP bind for AD accounts. The **second factor** is a NetOps-managed TOTP code. A session is created only after the second factor succeeds. The AD first factor, provider routing, provisioning, and directory error handling are specified in the **Active Directory Authentication** spec (`.kiro/specs/ad-authentication/`).

#### Acceptance Criteria

1. WHEN a client sends a valid identifier (an email or, for AD accounts, a username) and password to `POST /api/auth/login`, THE Auth_Service SHALL verify the First_Factor — an Argon2 password check for a LOCAL account, or an Active Directory bind for an AD account — and SHALL NOT create a session at this step.
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

### Requirement 4: ACL Operations (via n8n)

**User Story:** As a network engineer, I want to show, add, and delete ACLs through a guided form that previews the command and then executes it via n8n, so that I can perform ACL changes with a clear preview and a full audit trail, without this application ever touching a device directly.

The three ACL operations map to the RBAC permissions `ACL_POLICIES_SHOW`, `ACL_POLICIES_ADD`, and `ACL_POLICIES_DELETE`. `SHOW` is read-only and executes immediately; `ADD` and `DELETE` change device configuration and require a preview + explicit confirmation before execution. The n8n webhook contract and payload shapes are specified in the **n8n Integration** spec.

#### Acceptance Criteria

1. WHEN a user holding `ACL_POLICIES_SHOW` submits a valid ACL show request (a filter such as an IP address or ACL name) to the ACL show endpoint, THE ACL_Service SHALL forward the request to the N8N_Client for read-only execution and SHALL NOT require a confirmation step.
2. WHEN the N8N_Executor returns an ACL show result, THE ACL_Service SHALL return the device output to the Frontend for display as raw terminal output (and, where a parser exists, as a structured table) and SHALL record a SHOW Audit_Log.
3. THE ACL_Service SHALL validate ACL add input for the fields it collects (which MAY include name, source, source_mask, destination, destination_mask, protocol, port, action, time range, change_ticket, and description) using the Validation_Layer before any preview or execution.
4. THE ACL_Service SHALL accept protocol values of `TCP`, `UDP`, `ICMP`, and `ANY`.
5. WHERE the protocol is `TCP` or `UDP`, THE Validation_Layer SHALL require a port within the range 1 to 65535 inclusive.
6. WHERE the protocol is `ICMP`, THE Validation_Layer SHALL reject any supplied port.
7. THE ACL_Service SHALL accept action values of `ALLOW` and `DENY`.
8. WHEN a user requests a command preview for an ACL add or delete, THE ACL_Service SHALL build a Command_Preview from the matching static Command_Template and the submitted field values, and SHALL apply Redaction so the Execution_Credentials appear only as `***`.
9. WHEN a user holding `ACL_POLICIES_ADD` confirms execution of a previewed ACL add, THE ACL_Service SHALL send the field payload (including the Correlation_Id and Execution_Credentials) to the N8N_Client and SHALL record the resulting ADD Audit_Log with status SUCCESS or FAILED based on the n8n response.
10. WHEN a user holding `ACL_POLICIES_DELETE` confirms execution of a previewed ACL delete, THE ACL_Service SHALL send the field payload (including the Correlation_Id and Execution_Credentials) to the N8N_Client and SHALL record the resulting DELETE Audit_Log with status SUCCESS or FAILED based on the n8n response.
11. THE ACL_Service SHALL send only the field payload required by n8n and SHALL NOT send the Command_Preview string to n8n.
12. THE ACL_Service SHALL NOT persist any ACL configuration row of its own; the only ACL persistence THE ACL_Service performs is writing Audit_Logs.
13. IF the N8N_Client cannot reach n8n, the request times out, or n8n returns an error, THEN THE ACL_Service SHALL record an Audit_Log with status FAILED capturing the error and SHALL return a safe error to the client that excludes the Execution_Credentials.
14. THE ACL_Service SHALL exclude the raw Execution_Credentials from every Audit_Log, storing them only in redacted (`***`) form within the command snapshot.
15. THE ACL_Service SHALL attach the same Correlation_Id to the request payload, the n8n call, and the recorded Audit_Log for one operation.

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

### Requirement 6: Route Operations (via n8n)

**User Story:** As a network engineer, I want to show, add, and delete routes through a guided form that previews the command and then executes it via n8n, so that I can perform routing changes with a clear preview and a full audit trail, without this application ever touching a device directly.

The three route operations map to the RBAC permissions `ROUTES_SHOW`, `ROUTES_ADD`, and `ROUTES_DELETE`. `SHOW` is read-only and executes immediately; `ADD` and `DELETE` change device configuration and require a preview + explicit confirmation before execution.

#### Acceptance Criteria

1. WHEN a user holding `ROUTES_SHOW` submits a valid route show request (a filter such as a destination or next hop) to the route show endpoint, THE Route_Service SHALL forward the request to the N8N_Client for read-only execution and SHALL NOT require a confirmation step.
2. WHEN the N8N_Executor returns a route show result, THE Route_Service SHALL return the device output to the Frontend for display as raw terminal output (and, where a parser exists, as a structured table) and SHALL record a SHOW Audit_Log.
3. THE Route_Service SHALL validate route add input for the fields it collects (which MAY include name, destination, source, next_hop, policy, time range, and change_ticket) using the Validation_Layer before any preview or execution.
4. WHEN input for the destination field is validated, THE Validation_Layer SHALL require valid CIDR notation.
5. WHEN input for the next_hop field is validated, THE Validation_Layer SHALL require a valid IP address and SHALL reject an invalid next hop.
6. WHEN a user requests a command preview for a route add or delete, THE Route_Service SHALL build a Command_Preview from the matching static Command_Template and the submitted field values, and SHALL apply Redaction so the Execution_Credentials appear only as `***`.
7. WHEN a user holding `ROUTES_ADD` confirms execution of a previewed route add, THE Route_Service SHALL send the field payload (including the Correlation_Id and Execution_Credentials) to the N8N_Client and SHALL record the resulting ADD Audit_Log with status SUCCESS or FAILED based on the n8n response.
8. WHEN a user holding `ROUTES_DELETE` confirms execution of a previewed route delete, THE Route_Service SHALL send the field payload (including the Correlation_Id and Execution_Credentials) to the N8N_Client and SHALL record the resulting DELETE Audit_Log with status SUCCESS or FAILED based on the n8n response.
9. THE Route_Service SHALL send only the field payload required by n8n and SHALL NOT send the Command_Preview string to n8n, and SHALL NOT persist any route configuration row of its own; the only route persistence THE Route_Service performs is writing Audit_Logs.
10. IF the N8N_Client cannot reach n8n, the request times out, or n8n returns an error, THEN THE Route_Service SHALL record an Audit_Log with status FAILED capturing the error and SHALL return a safe error to the client that excludes the Execution_Credentials.
11. THE Route_Service SHALL exclude the raw Execution_Credentials from every Audit_Log, storing them only in redacted (`***`) form within the command snapshot.
12. THE Route_Service SHALL attach the same Correlation_Id to the request payload, the n8n call, and the recorded Audit_Log for one operation.

### Requirement 7: Command Preview and Delegated Execution

**User Story:** As a network engineer, I want to see a redacted preview of the command before it runs and have the execution performed by n8n, so that I can review exactly what will happen while credentials stay protected and this application never touches a device.

#### Acceptance Criteria

1. THE NetOps_Policy_Manager SHALL maintain static Command_Templates — at minimum one each for ACL add, ACL delete, route add, and route delete — with placeholders for the dynamic field values.
2. WHEN building a Command_Preview, THE NetOps_Policy_Manager SHALL substitute the operator's submitted field values into the matching Command_Template and SHALL apply Redaction to the Execution_Credentials.
3. THE Command_Preview SHALL be produced on the server and returned to the client for display only; it SHALL be display/audit-only and SHALL NOT be the payload sent to n8n.
4. THE NetOps_Policy_Manager SHALL NOT itself open any SSH/NETCONF/API session to a network device; all execution SHALL be delegated to the N8N_Executor.
5. THE payload sent to n8n SHALL consist of the operator's field values (plus Correlation_Id and Execution_Credentials), not a rendered command string; the N8N_Executor is responsible for composing and running the actual device command.
6. THE `server/network/` directory SHALL be the boundary for the N8N_Client and Command_Template/preview logic, and SHALL NOT contain simulated device connections.
7. WHERE a show operation returns device output, THE NetOps_Policy_Manager SHALL treat that output as untrusted data for display and parsing, not as instructions.

### Requirement 8: Audit Trail (system of record)

**User Story:** As a compliance auditor, I want every login, user-admin change, and ACL/route operation recorded with its request, command preview, n8n execution metadata, and device response, so that I can review and export a complete, linkable history — since this database is the system of record for what was requested and what happened.

#### Acceptance Criteria

1. THE Audit_Service SHALL record an Audit_Log for the activities LOGIN (success/failed), LOGOUT, USER (create/update/role-change/status-change/password-reset), ACL (show/add/delete), and ROUTE (show/add/delete), and SHALL classify each by a `module` (`AUTH` | `USER` | `ACL` | `ROUTE` | `N8N`) and an `action` (`LOGIN` | `SHOW` | `ADD` | `DELETE` | `UPDATE`).
2. THE Data_Layer SHALL store each Audit_Log with the columns `id` (UUID PK), `user_id` (UUID, nullable — a failed login may have no known user), `username` (snapshot at action time), `user_role` (snapshot at action time), `module`, `action`, `status` (`SUCCESS` | `FAILED`), `source_ip`, `user_agent`, `correlation_id`, and `created_at`.
3. THE Data_Layer SHALL store, per Audit_Log, four flexible JSONB payload columns: `request_payload` (the submitted field values / filter), `command_payload` (the redacted command snapshot actually representing the operation, e.g. `{ device, command: [...] }`), `execution_payload` (n8n execution metadata such as executor, workflow_id, execution_id, started_at, finished_at, duration_ms), and `response_payload` (the device output or error, e.g. `{ device, output }` or `{ device, error }`).
4. THE Audit_Service SHALL exclude passwords, password hashes, Session_Tokens, cookie values, authorization headers, the DATABASE_URL value, the n8n API key, and the raw Execution_Credentials from every Audit_Log and every JSONB payload; the Execution_Credentials SHALL appear only as `***`.
5. WHEN an operation is delegated to n8n, THE Audit_Service SHALL record the Correlation_Id on the Audit_Log so the request, the n8n execution, the device command, and the device response are linkable as one operation.
6. WHEN an operation completes, THE Audit_Service SHALL set `status` to `SUCCESS` or `FAILED` according to the outcome (including n8n/device errors and unreachable-n8n cases).
7. THE API_Layer SHALL NOT expose any endpoint that deletes or mutates Audit_Logs during normal operation.
8. WHEN any authenticated user opens the `/logs` (Log Trail) page, THE Frontend SHALL provide search, date filtering, module/action filtering, status filtering, and pagination.
9. WHEN any authenticated user selects an Audit_Log, THE Frontend SHALL display a detail view including the four JSONB payloads.
10. WHEN any authenticated user requests an export, THE Audit_Service SHALL produce an export of the selected Audit_Logs.
11. THE Log Trail SHALL be available to every authenticated user and SHALL NOT require a feature Permission.
12. WHERE an Audit_Log JSONB payload shape must change to match n8n's evolving request/response, THE NetOps_Policy_Manager SHALL accommodate the change through the flexible JSONB columns without a schema migration to the fixed columns.

### Requirement 9: Dashboard

**User Story:** As an operator, I want a lightweight summary dashboard of activity and execution, so that I can see request volume, success/failure, and recent activity at a glance — derived from the audit log rather than from device state.

Because this application is not the source of truth for ACL/route configuration, the dashboard summarizes `audit_logs`, not counts of ACLs/routes. Actual counts of ACLs/routes on devices, if ever needed, would require a query to n8n/devices and are out of scope for this phase.

#### Acceptance Criteria

1. WHEN an authenticated user opens the dashboard, THE Dashboard_Service SHALL return the total number of requests/executions recorded in `audit_logs` over the summarized window.
2. WHEN an authenticated user opens the dashboard, THE Dashboard_Service SHALL return the counts of SUCCESS versus FAILED executions.
3. WHEN an authenticated user opens the dashboard, THE Dashboard_Service SHALL return a breakdown of activity per module (at least ACL and ROUTE).
4. WHEN an authenticated user opens the dashboard, THE Dashboard_Service SHALL return a list of recent activities (recent Audit_Logs).
5. WHEN an authenticated user opens the dashboard, THE Dashboard_Service SHALL return a summary of failed executions/errors.
6. THE Dashboard_Service SHALL derive all metrics from `audit_logs` and SHALL NOT report counts of ACL/route configuration from a local store (there is none).
7. THE Dashboard_Service SHALL present summary metrics without complex chart rendering.

### Requirement 10: Data Model and Persistence

**User Story:** As a developer, I want a well-constrained relational schema, scoped to identity/RBAC/session/audit, with parameterized queries, so that data integrity and query safety are guaranteed and no device configuration state is stored.

#### Acceptance Criteria

1. THE Data_Layer SHALL define Drizzle schemas for the tables users, roles, permissions, roles_permissions, sessions, user_mfa, and audit_logs.
2. THE Data_Layer SHALL NOT define any `acl_policies` or `routes` configuration table; this application does not store network device configuration state.
3. THE Data_Layer SHALL use UUID values as primary key identifiers.
4. THE Data_Layer SHALL enforce a unique constraint on the users email column, a unique constraint on the users external_id column, and a partial unique constraint on the users username column (where username is not null) for directory-provisioned accounts.
5. THE Data_Layer SHALL define foreign key constraints between related tables.
6. THE Data_Layer SHALL prevent duplicate Permission assignments for the same Role via a unique constraint on `roles_permissions(role_id, permission_id)`.
7. THE Data_Layer SHALL define indexes on user email, user role_id, session token hash, session user, and on the audit log's `created_at`, `user_id`, `module`, `action`, `status`, and `correlation_id`.
8. THE Data_Layer SHALL execute all queries as parameterized Drizzle queries.

### Requirement 11: Application Schema Layering

**User Story:** As a developer, I want separate, explicit model layers derived from Zod, so that database rows are never exposed and mass-assignment is prevented.

#### Acceptance Criteria

1. THE NetOps_Policy_Manager SHALL define separate models for the Database layer, Domain layer, API Request layer, API Response layer, and UI Form layer.
2. THE NetOps_Policy_Manager SHALL derive application types from Zod schemas using `z.infer`.
3. THE API_Layer SHALL NOT return raw Database rows to the Frontend.
4. THE API_Layer SHALL accept input only through explicit API Request schemas that exclude server-controlled fields (such as `id`, `correlation_id`, `created_at`, and the audit `status`), preventing mass-assignment.

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
12. WHEN a user completes an ACL/route add or delete form and requests a preview, THE Frontend SHALL display the redacted Command_Preview in a terminal-style box and SHALL change the primary action from "Generate" to "Execute Command".
13. WHEN a user clicks "Execute Command" for an add or delete, THE Frontend SHALL present a confirmation interface before sending the execution request to the server.
14. WHEN a show/execute result returns from n8n, THE Frontend SHALL display the raw device output (and a structured table where a parser exists) and SHALL surface a SUCCESS or FAILED outcome.
15. THE Frontend SHALL NOT display the raw Execution_Credentials in the Command_Preview or anywhere in the UI; they SHALL appear only as `***`.
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

1. THE NetOps_Policy_Manager SHALL provide a `.env.example` file containing placeholder entries — without real credentials — for at least `NODE_ENV`, `DATABASE_URL`, `SESSION_SECRET`, `MFA_ENCRYPTION_KEY`, `SESSION_TTL_HOURS`, `MFA_CHALLENGE_TTL_MINUTES`, the seed-user variables, the Active Directory variables (`AD_ENABLED`, `AUTH_LOCAL_ENABLED`, `AD_URL`, `AD_BASE_DN`, `AD_BIND_DN`, `AD_BIND_PASSWORD`, and any AD timeout/discovery flags) as specified in the Active Directory Authentication spec, and the n8n integration variables (`N8N_BASE_URL` / webhook URLs, `N8N_API_KEY`, and `N8N_TIMEOUT_MS`) as specified in the n8n Integration spec.
2. WHEN the application starts, THE Config_Service SHALL validate the required environment variables with a Zod schema, including the conditional AD variables that become required when `AD_ENABLED` is true and the n8n variables required for ACL/route execution.
3. IF a required environment variable is missing or invalid at startup, THEN THE Config_Service SHALL halt startup with an error.
4. THE NetOps_Policy_Manager SHALL keep the n8n API key server-side only and SHALL NOT expose it via `runtimeConfig.public` or any client response.
5. THE NetOps_Policy_Manager SHALL NOT create or provision a PostgreSQL database.
6. THE NetOps_Policy_Manager SHALL NOT run database migrations automatically at startup.
7. THE NetOps_Policy_Manager SHALL NOT fall back to SQLite or any embedded database.

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
11. THE NetOps_Policy_Manager SHALL include a Vitest test that confirms the Command_Preview redacts the Execution_Credentials to `***`.
12. THE NetOps_Policy_Manager SHALL include a Vitest test that confirms the raw Execution_Credentials never appear in any Audit_Log or JSONB payload.
13. THE NetOps_Policy_Manager SHALL include a Vitest test that confirms a password hash never appears in an API response.
14. THE NetOps_Policy_Manager SHALL include a Vitest test that confirms an ACL add/delete operation produces an Audit_Log carrying the Correlation_Id.
15. THE NetOps_Policy_Manager SHALL include a Vitest test that confirms a route add/delete operation produces an Audit_Log carrying the Correlation_Id.
16. THE NetOps_Policy_Manager SHALL include a Vitest test that confirms an unreachable-n8n or n8n-error outcome is recorded as a FAILED Audit_Log and returned as a safe client error without leaking credentials.
17. THE NetOps_Policy_Manager SHALL pass type checking, linting, the test suite, and a production build.

## Non-Functional Requirements

### Security

1. THE NetOps_Policy_Manager SHALL store LOCAL passwords only as Argon2 hashes, and SHALL never store any AD user's directory password or a hash of it (`password_hash` stays null for AD accounts).
2. THE NetOps_Policy_Manager SHALL store only session token hashes and SHALL keep raw Session_Tokens in HttpOnly cookies.
3. THE NetOps_Policy_Manager SHALL store TOTP secrets only in encrypted form (AES-256-GCM) and SHALL never return a TOTP secret to the client except within the enrollment otpauth URI needed to render the QR code.
4. THE NetOps_Policy_Manager SHALL enforce all authentication and authorization checks on the server.
5. THE NetOps_Policy_Manager SHALL prevent mass-assignment by accepting mutations only through explicit request schemas.
6. THE NetOps_Policy_Manager SHALL exclude secrets, credentials, and sensitive internal details from client responses, audit entries, and the health endpoint.
7. THE NetOps_Policy_Manager SHALL never persist the Execution_Credentials and SHALL redact them to `***` before any preview, response, or audit write.
8. THE NetOps_Policy_Manager SHALL authenticate every call to n8n with the server-held n8n API key and SHALL never expose that key to the client.

### Performance and Footprint

1. THE NetOps_Policy_Manager SHALL apply server-side pagination to all list endpoints to bound response size.
2. THE NetOps_Policy_Manager SHALL operate as a lightweight application suitable for a constrained internal server.
3. THE Dashboard_Service SHALL avoid complex chart rendering to minimize client load.

### Maintainability

1. THE NetOps_Policy_Manager SHALL be written in TypeScript with strict type checking enabled.
2. THE NetOps_Policy_Manager SHALL derive application types from Zod schemas to keep validation and types aligned.
3. THE NetOps_Policy_Manager SHALL isolate the n8n webhook interaction behind the N8N_Client and keep the static Command_Templates in one place, so the integration and preview syntax can change without touching the request/audit layers.

### Accessibility

1. THE Frontend SHALL provide labeled form controls and semantic buttons.
2. THE Frontend SHALL present readable validation error messages.
3. THE Frontend SHALL support keyboard navigation for interactive controls.

## Out of Scope

The following are explicitly NOT part of NetOps Policy Manager and SHALL NOT be built. Note the boundary: device execution is real but is owned by n8n; this application is the operator interface and the audit system of record, and never talks to a device itself.

1. Direct execution against routers, firewalls, or switches by this application (this app never opens an SSH/NETCONF/API session to a device; execution is delegated to n8n).
2. Any in-app SSH, NETCONF, Ansible, NAPALM, or Netmiko client, or an in-app SSH jump-host connection (these live in n8n).
3. Storing device SSH credentials (device credentials are configured in n8n; this app forwards the per-engineer Execution_Credentials to n8n at execute time but never persists them).
4. Persisting ACL/route configuration state as a source of truth (the app stores audit logs only; device state is reached through n8n show operations).
5. Building or owning the n8n workflows themselves (this app only calls the n8n webhook per the n8n Integration contract).
6. Approval/multi-stage sign-off workflows beyond the single execute confirmation step.
7. ServiceNow or Jira integration.
8. Email or SMS notifications.
9. Message queue integration.
10. Redis or any additional caching datastore.
11. Microservices architecture.
12. Kubernetes orchestration.
13. CI/CD pipeline definitions.
14. Cloud deployment automation.
