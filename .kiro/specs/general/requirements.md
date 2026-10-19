# Requirements Document — General (System Overview)

## Introduction

This is the **umbrella / overview module** for NetOps Policy Manager. It holds the
system-wide facts that every other module depends on: the system purpose and
scope, the high-level architecture, the request layering convention, the API
response envelope, the correlation id, the model-layering rules, configuration
and startup validation, packaging, and the shared glossary. Module-specific
behavior lives in the per-module specs cross-linked at the end of this document;
only cross-module concepts belong here.

NetOps Policy Manager is a lightweight internal web application that provides an
authenticated, role-based **interface and audit system of record** for network
Access Control List (ACL) and route operations. Network engineers submit ACL and
route requests (show, add, delete) through the application; the actual execution
against network devices is performed by an external **n8n** automation workflow
(behind an SSH jump host). The application never executes device commands itself
and never stores network device configuration. It validates and captures the
operator's intent, shows a redacted command preview for add/delete actions,
delegates execution to n8n over an authenticated webhook, waits for the result,
and records every request and its outcome as an immutable audit log.

The PostgreSQL database is an **identity / RBAC / session / audit layer, not the
source of truth** for ACL/route state. Live device state is reached only through
n8n (read-only `show` commands); the application persists no ACL or route
configuration rows of its own.

### Scope

In scope for this module:

- System purpose, scope, and high-level architecture.
- The request layering convention shared by every API endpoint.
- The API response envelope, server-side pagination, and safe error handling.
- The correlation id concept that links one operation end-to-end.
- The model-layering rules (Zod as the source of truth, never raw rows).
- Configuration validation at startup and the no-provisioning posture.
- Packaging and the health endpoint.
- The shared, cross-module glossary.
- The cross-link index to every other module spec.

Out of scope here (owned by the module specs): the ACL/ROUTE field contracts,
the n8n webhook contract, the iTop ticket integration, authentication and MFA
flows, the RBAC catalog, the audit/Log-Trail schema detail, user management, and
the dashboard widgets.

## Glossary

System-wide terms used across modules. Module-specific terms live in their own
module docs.

- **NetOps_Policy_Manager**: The complete web application described by these specs — one Nuxt application (Vue 3 client + Nitro server) plus its PostgreSQL database.
- **Auth_Service**: The server component responsible for first-factor verification (LOCAL password or AD bind), MFA challenge issuance, session issuance, and session validation. Detailed in the `authentication/` spec.
- **Authorization_Service**: The server component that resolves a user's effective permissions from data and enforces them via `hasPermission()` and `requirePermission()`. Detailed in the `rbac-permissions/` spec.
- **Data_Layer**: The Drizzle ORM schema and query layer backed by PostgreSQL. Its purpose is identity, RBAC, sessions, and audit logging — not ACL/route configuration state. It is the only layer that touches Drizzle.
- **API_Layer**: The Nitro server routes exposing HTTP endpoints under `/api`.
- **Frontend**: The Nuxt / Vue 3 client application (`<script setup lang="ts">` SFCs).
- **Config_Service**: The server component that validates environment configuration once at startup (the Zod `EnvSchema`).
- **Correlation_Id**: A unique identifier generated for every operation and carried unchanged through the whole chain — Web request → n8n execution → device command → device response — and stored on the audit log so the full trail of one operation is linkable.
- **Redaction**: Replacing sensitive values (at minimum the device execution credentials) with `***` before a command preview is shown to the client or written to an audit log.
- **API_Envelope**: The standard response shape `{ success: true, data }` on success or `{ success: false, error: { code, message, fields? } }` on failure.
- **Production_Environment**: A runtime where `NODE_ENV` equals `production`.

## Requirements

### Requirement 1: System purpose and boundary

**User Story:** As an operator, I want the application to be a safe interface and audit record for ACL/route operations, so that I can act on network policy without the app ever touching a device directly.

#### Acceptance Criteria

1. THE NetOps_Policy_Manager SHALL provide an authenticated, role-based interface for ACL and route operations (show, add, delete) and SHALL record every operation as an immutable audit log.
2. THE NetOps_Policy_Manager SHALL NOT open any SSH, NETCONF, or device API session itself; all execution SHALL be delegated to the external n8n executor (see the `n8n-integration/` spec).
3. THE NetOps_Policy_Manager SHALL NOT persist any ACL or route configuration-state table; the Data_Layer stores only identity, RBAC, sessions, and audit records.
4. THE NetOps_Policy_Manager SHALL treat the PostgreSQL database as the audit system of record and SHALL reach live device state only through n8n read operations.

### Requirement 2: High-level architecture

**User Story:** As a developer, I want a clear picture of the moving parts, so that I know where each responsibility lives.

#### Acceptance Criteria

1. THE NetOps_Policy_Manager SHALL be a single Nuxt 4 application comprising a Vue 3 client and a Nitro server, backed by PostgreSQL via Drizzle ORM.
2. THE NetOps_Policy_Manager SHALL delegate ACL/route execution to an external n8n automation workflow over an authenticated webhook (see the `n8n-integration/` spec).
3. THE NetOps_Policy_Manager SHALL read ticket data from iTop as a FOREIGN, read-only MariaDB accessed via `mysql2`, which is NOT part of the Drizzle schema (see the `ticketing-itop/` spec).
4. THE Data_Layer SHALL be the only layer that uses Drizzle, and SHALL back identity, RBAC, sessions, and audit tables only.

### Requirement 3: Request layering convention

**User Story:** As a developer, I want every endpoint to follow the same pipeline, so that handlers stay thin and business logic is consistently placed.

#### Acceptance Criteria

1. THE API_Layer SHALL process every request through the layering: API handler (thin) → Zod validation → authentication (session resolution) → authorization (`requirePermission`) → service (business logic and transactions) → repository (Drizzle only) → PostgreSQL.
2. THE API handler SHALL hold no business logic and SHALL delegate domain logic to a service.
3. THE repository layer SHALL be the only layer that issues Drizzle queries, and services SHALL reach the database only through repositories.
4. THE API_Layer SHALL resolve the authenticated user per request via the shared `requireAuthenticatedUser` / `requirePermission` helpers (session cookie → session row → user), rather than trusting any client-supplied identity. *(The current build performs this per handler; there is no global session middleware.)*

### Requirement 4: API response envelope

**User Story:** As a client developer, I want a consistent response shape and safe errors, so that responses are predictable and never leak internals.

#### Acceptance Criteria

1. WHEN a request succeeds, THE API_Layer SHALL respond with `{ success: true, data }`.
2. WHEN a request fails, THE API_Layer SHALL respond with `{ success: false, error: { code, message, fields? } }`.
3. WHEN input validation fails, THE API_Layer SHALL populate `error.fields` with the offending field details and SHALL use the `VALIDATION_ERROR` code.
4. THE API_Layer SHALL draw every error `code` from the fixed `ErrorCode` union: `INVALID_CREDENTIALS`, `INVALID_VERIFICATION_CODE`, `MFA_CHALLENGE_INVALID`, `MFA_DEVICE_LIMIT_REACHED`, `MFA_DEVICE_NOT_FOUND`, `MFA_LAST_DEVICE`, `UNAUTHENTICATED`, `FORBIDDEN`, `VALIDATION_ERROR`, `FORBIDDEN_ORIGIN`, `NOT_FOUND`, `TICKET_NOT_FOUND`, `CONFLICT`, `AD_UNREACHABLE`, `ITOP_UNREACHABLE`, `ACCOUNT_DISABLED`, `SELF_DISABLE_FORBIDDEN`, `DEVICE_CREDENTIALS_REQUIRED`, `INTERNAL_ERROR`.
5. WHEN a client requests any list resource, THE API_Layer SHALL apply server-side pagination to bound the response size.
6. IF an internal error occurs, THEN THE API_Layer SHALL exclude database error text, SQL, stack traces, filesystem paths, and secrets from the client response, and SHALL log the detail on the server only.

### Requirement 5: Correlation id

**User Story:** As a compliance auditor, I want one operation linkable end-to-end, so that I can trace a request through n8n to the device and back.

#### Acceptance Criteria

1. THE NetOps_Policy_Manager SHALL generate a unique Correlation_Id for every operation.
2. THE NetOps_Policy_Manager SHALL carry the same Correlation_Id unchanged across the request, the n8n call, the device command, and the recorded audit log.
3. THE Audit_Service SHALL store the Correlation_Id on the audit log so the request, the n8n execution, and the device response are linkable as one operation (see the `log-trail/` and `n8n-integration/` specs).

### Requirement 6: Model layering

**User Story:** As a developer, I want explicit model layers derived from Zod, so that database rows are never exposed and mass-assignment is prevented.

#### Acceptance Criteria

1. THE NetOps_Policy_Manager SHALL treat Zod schemas in `shared/schemas/` as the single source of truth for data shapes, used on both client and server.
2. THE NetOps_Policy_Manager SHALL derive application types from Zod schemas with `z.infer`, and SHALL NOT maintain parallel hand-written interfaces for the same shapes.
3. THE API_Layer SHALL NOT return raw database rows to the Frontend; every response SHALL be mapped to a Zod response shape (e.g. `toUserResponse`) that excludes secrets.
4. THE API_Layer SHALL accept input only through explicit request schemas that exclude server-controlled fields (such as `id`, `correlation_id`, timestamps, `createdBy`, and the generated command), preventing mass-assignment.
5. WHEN the Frontend submits validated input, THE API_Layer SHALL re-validate that input on the server.

### Requirement 7: Configuration and startup validation

**User Story:** As an operator, I want validated configuration and no implicit database provisioning, so that deployment behavior is explicit and safe.

#### Acceptance Criteria

1. WHEN the application starts, THE Config_Service SHALL validate the environment against the Zod `EnvSchema`, and SHALL halt startup if a required variable is missing or invalid.
2. THE Config_Service SHALL validate at least `NODE_ENV`, the discrete PostgreSQL connection parts (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`), `SESSION_SECRET` (min 32 chars), `COOKIE_SECURE`, `MFA_ENCRYPTION_KEY` (64 hex chars), `SESSION_TTL_HOURS`, `MFA_CHALLENGE_TTL_MINUTES`, the Active Directory variables (`AD_ENABLED`, `AUTH_LOCAL_ENABLED`, `AD_URL`, `AD_BASE_DN`, `AD_BIND_DN`, `AD_BIND_PASSWORD`, `AD_TIMEOUT_MS`), the n8n variables (`N8N_BASE_URL`, `N8N_API_KEY`, `N8N_TIMEOUT_MS`), and the optional iTop variables (`ITOP_HOST`, `ITOP_PORT`, `ITOP_NAME`, `ITOP_USER`, `ITOP_PASSWORD`, `ITOP_TIMEOUT_MS`).
3. THE Config_Service SHALL assemble `DATABASE_URL` from the discrete `DB_*` parts (percent-encoding the user and password) rather than reading a pre-built URL, and SHALL assemble `ITOP_DATABASE_URL` from the `ITOP_*` parts only when iTop is fully configured.
4. WHERE `AD_ENABLED` is true, THE Config_Service SHALL require `AD_URL`, `AD_BASE_DN`, `AD_BIND_DN`, and `AD_BIND_PASSWORD` to all be present (see the `authentication/` spec).
5. THE Config_Service SHALL treat iTop as all-or-nothing: either none of `ITOP_HOST` / `ITOP_NAME` / `ITOP_USER` / `ITOP_PASSWORD` are set (feature off) or all four are set; a partial iTop configuration SHALL halt startup (see the `ticketing-itop/` spec).
6. THE NetOps_Policy_Manager SHALL keep every secret server-side only and SHALL NOT expose any secret via `runtimeConfig.public`.
7. THE NetOps_Policy_Manager SHALL provide a `.env.example` file with placeholder entries — without real credentials — for every variable the Config_Service validates.
8. THE NetOps_Policy_Manager SHALL NOT create or provision a PostgreSQL database, SHALL NOT run migrations automatically at startup, and SHALL NOT fall back to SQLite or any embedded database.

### Requirement 8: Packaging and health

**User Story:** As an operator, I want a single self-contained image and a simple health signal, so that I can deploy and monitor the app without bundling a database.

#### Acceptance Criteria

1. THE NetOps_Policy_Manager SHALL build as a single multi-stage Docker image and SHALL NOT bundle PostgreSQL, database data, `.env` files, `.git` data, development cache, test artifacts, or secrets.
2. THE NetOps_Policy_Manager SHALL NOT include a PostgreSQL container or a docker-compose definition for the database.
3. WHERE a health endpoint `GET /api/health` is provided, THE API_Layer SHALL respond with `{ success: true, data: { status: "healthy" } }` and SHALL exclude secrets. **(unverified — a `server/api/health.get.ts` route is NOT present in the current build; this requirement describes the intended contract and should be reconciled when the endpoint is added or the requirement is retired.)**

## Non-Functional Requirements

### Security

1. THE NetOps_Policy_Manager SHALL enforce every authentication and authorization check on the server, independent of any Frontend behavior.
2. THE NetOps_Policy_Manager SHALL exclude secrets, credentials, SQL, stack traces, and filesystem paths from client responses and audit entries.
3. THE NetOps_Policy_Manager SHALL guard cookie-authenticated mutations with a same-origin check (`assertSameOrigin`) as defense-in-depth over the `SameSite=Lax` cookie.

### Maintainability

1. THE NetOps_Policy_Manager SHALL be written in TypeScript with strict type checking enabled.
2. THE NetOps_Policy_Manager SHALL keep Zod schemas as the shared source of truth so validation and types stay aligned across client and server.

## Cross-link index

The ten module specs. Each folder holds exactly one `requirements.md`.

- **general/** (this document) — system overview, architecture, layering, envelope, correlation id, config, packaging, and the shared glossary.
- **database/** — the full PostgreSQL schema: every table, enum, relationship, index, delete behavior, plus the migration and seed posture.
- **authentication/** — LOCAL password + Active Directory first factor, server-side sessions, NetOps-managed TOTP MFA, and the two-step login flow.
- **rbac-permissions/** — data-driven roles, the permission catalog, the role→permission mapping, `users.role_id`, and server + frontend gating.
- **netops-policy-manager/** — the ACL and ROUTE module: show/add/delete workflow, the simplified field set, command preview, and network-input validation.
- **n8n-integration/** — the authenticated n8n webhook contract, field payloads, correlation id header, device session credentials, and the execute guard.
- **ticketing-itop/** — the read-only iTop MariaDB ticket search/preview, the required change-ticket gate, and the server-side ticket-existence guard.
- **log-trail/** — the `audit_logs` master table, the `acl_logs` / `route_logs` detail tables, the two-row AUTH model, and the `/logs` UI.
- **user-management/** — the Administration user list, role/status changes, and the disabled create / password-reset posture.
- **dashboard/** — the independent dashboard widget endpoints derived from `audit_logs`, one subsection per widget.
