# Requirements Document — Authentication

## Introduction

This spec defines the complete **authentication** behavior of NetOps Policy
Manager as it now stands: the two-step login flow, both first-factor providers
(**LOCAL** email + Argon2 password and **AD** Active Directory LDAP bind), the
NetOps-managed **TOTP second factor**, and the server-side **session**. It
consolidates the former `ad-authentication` spec with the auth/session/MFA
material that previously lived in the main NetOps Policy Manager spec, so this is
the single source of truth for how a user signs in.

Authentication is a two-step flow:

1. **First factor** — identity + password. For LOCAL accounts this is an Argon2
   password check; for AD accounts it is an LDAP bind against Active Directory.
   The first factor never creates a session; on success it issues a short-lived,
   signed MFA challenge cookie.
2. **Second factor** — a NetOps-managed TOTP code tied to the MFA challenge. A
   session is created only after the second factor succeeds.

Everything after a successful first factor (MFA challenge → TOTP → session) is
provider-agnostic (keyed on `user_id`); LOCAL and AD share it unchanged. AD is a
second first-factor provider only — AD is read-only (bind + search), NetOps never
stores an AD password, and provisioning, routing, MFA, and sessions are owned by
NetOps.

Cross-links: `general/` (envelope, config, correlation id), `rbac-permissions/`
(a provisioned user starts with `role_id = null`), `log-trail/` (the two-row AUTH
audit model).

### Scope

- The two-step login flow and its status transitions.
- LOCAL first factor (email + Argon2).
- AD first factor (LDAP bind + search + user-bind), provider routing, JIT
  provisioning, and directory error handling.
- Server-side sessions (hash-only token, cookie flags, expiry + last-used).
- NetOps-managed TOTP MFA (enrollment, confirmation, verification, up to two
  devices, encrypted secret, signed challenge cookie).
- Disabled-account gates (NetOps `is_active` and AD `ACCOUNTDISABLE`).
- Configuration variables and the admin-bootstrap / production posture.

## Glossary

- **First_Factor**: Identity + password verification. Argon2 check for LOCAL; an LDAP bind for AD.
- **Auth_Provider**: The persisted origin of an account: `LOCAL` or `AD` (`users.auth_provider`).
- **Directory_Provider**: The server component that connects to AD, binds the service account, searches for a user, and verifies the user's password via an LDAP bind. Read-only against the directory.
- **Service_Account**: The AD bind account (`AD_BIND_DN` / `AD_BIND_PASSWORD`) used to connect and search; never stored by NetOps and not an application user.
- **User_Bind**: Re-binding to AD with the located user's DN and the supplied password to prove the password is correct.
- **JIT_Provisioning**: Creating a NetOps `users` row for an AD user on first successful login, with `auth_provider = 'AD'`, `password_hash = null`, and `role_id = null`.
- **External_Id**: The immutable AD identifier (`objectGUID`, formatted as a canonical GUID string) stored in `users.external_id`, used to recognize a returning AD user.
- **Provider_Routing**: The server-side decision of which provider verifies a given login attempt, governed by configuration and the identifier.
- **MFA_Challenge**: A short-lived, signed pre-auth cookie issued after a successful First_Factor, carrying the user id and a purpose (`MFA_ENROLLMENT` or `MFA_LOGIN`). It is a cookie, not a database table.
- **Session_Store**: The `sessions` table; it stores only the SHA-256 hash of each session token, never the raw token.
- **Session_Token**: A high-entropy raw token issued to the client and held only in the HttpOnly `netops_session` cookie.

## Requirements

### Requirement 1: Two-step login flow

**User Story:** As an operator, I want to log in with my identifier and password and then complete a TOTP second factor, so that only verified individuals with a second factor get a session.

#### Acceptance Criteria

1. WHEN a client sends an identifier (email, or an AD username) and password to `POST /api/auth/login`, THE Auth_Service SHALL verify the First_Factor via the resolved provider and SHALL NOT create a session at this step.
2. WHEN the First_Factor succeeds for a user with no confirmed MFA device, THE Auth_Service SHALL issue an MFA_Challenge with purpose `MFA_ENROLLMENT` and SHALL return the status `MFA_SETUP_REQUIRED`.
3. WHEN the First_Factor succeeds for a user with a confirmed MFA device, THE Auth_Service SHALL issue an MFA_Challenge with purpose `MFA_LOGIN` and SHALL return the status `MFA_REQUIRED`.
4. WHEN a client presents a valid `MFA_ENROLLMENT` challenge to the MFA setup endpoints, THE Auth_Service SHALL let the user enroll and confirm a TOTP device before any session is created.
5. WHEN a client sends a valid TOTP code with a valid `MFA_LOGIN` challenge to `POST /api/auth/mfa/verify`, THE Auth_Service SHALL consume the challenge, create a session, and return the status `AUTHENTICATED` with the user identity.
6. IF a client presents a TOTP code with no valid MFA_Challenge, an expired challenge, or an incorrect code, THEN THE Auth_Service SHALL reject with HTTP 401 and SHALL NOT create a session.
7. WHEN a client sends `POST /api/auth/logout` with a valid session, THE Auth_Service SHALL invalidate the corresponding session in the Session_Store.
8. WHEN a client sends `GET /api/auth/me` with a valid session, THE Auth_Service SHALL return the authenticated user identity and effective permissions in the API envelope.
9. THE Auth_Service SHALL guard `login`, `mfa/verify`, and the logout/mutation endpoints with the same-origin check as defense-in-depth over the `SameSite=Lax` cookie.

### Requirement 2: LOCAL first factor

**User Story:** As a LOCAL user, I want my email and password verified against a stored hash, so that only the correct password grants the first factor.

#### Acceptance Criteria

1. WHEN a login attempt is routed to the LOCAL provider, THE Auth_Service SHALL look the user up by email (lowercased) and SHALL verify the supplied password against the stored Argon2 hash.
2. THE Auth_Service SHALL store LOCAL passwords only as Argon2 hashes and SHALL never store a plaintext password.
3. IF the account is unknown, inactive, not a LOCAL account, or the password is wrong, THEN THE Auth_Service SHALL reject with a generic invalid-credentials failure that does not reveal which condition failed.
4. THE Auth_Service SHALL run a password verification against a dummy hash when the account is missing or unusable, so response timing does not reveal whether the account exists.

### Requirement 3: Provider routing (LOCAL vs AD)

**User Story:** As a developer, I want the server to decide which provider verifies a login, so that development can use both and production can be AD-only.

#### Acceptance Criteria

1. THE Auth_Service SHALL resolve the provider on the server only and SHALL NOT accept a client-supplied provider selection.
2. THE Auth_Service SHALL look up any existing account by email OR username (both stored lowercased) to recognize a returning user whether they typed their email or AD username.
3. WHEN the identifier matches an existing LOCAL account, THE Auth_Service SHALL route to LOCAL where `AUTH_LOCAL_ENABLED` is true, else reject with generic invalid credentials.
4. WHEN the identifier matches an existing AD account, THE Auth_Service SHALL route to AD where `AD_ENABLED` is true, else reject with generic invalid credentials.
5. WHEN the identifier matches no existing user, THE Auth_Service SHALL prefer AD where `AD_ENABLED` is true, otherwise LOCAL where `AUTH_LOCAL_ENABLED` is true, otherwise reject.
6. WHERE a production configuration sets `AUTH_LOCAL_ENABLED` to false, THE Auth_Service SHALL authenticate only through AD.
7. THE Auth_Service SHALL accept a login identifier that is either an AD username (`sAMAccountName`) or an email/UPN; `LoginSchema` carries a general `identifier` string, not an email-only field.

### Requirement 4: Disabled-account gates

**User Story:** As a security administrator, I want a disabled account stopped early with a clear message, so that a suspended user cannot authenticate.

#### Acceptance Criteria

1. WHEN a login identifier matches an existing NetOps user whose `is_active` is false, THE Auth_Service SHALL reject the attempt with the `ACCOUNT_DISABLED` error (HTTP 403) before any credential verification, and for an AD account before contacting the directory.
2. WHERE the front-of-flow lookup misses (an AD user logging in by `sAMAccountName` whose stored identifier is the email), THE Auth_Service SHALL re-check `is_active` after the AD bind and reject a disabled account.
3. IF the located directory entry is disabled in AD (the `ACCOUNTDISABLE` bit `0x2` of `userAccountControl` is set), THEN THE Directory_Provider SHALL reject with a distinct account-disabled outcome (HTTP 403) before the User_Bind, independently of the NetOps `is_active` gate.
4. THE Auth_Service SHALL NOT reveal, in a disabled-account response, any directory detail or whether the supplied password was correct.

### Requirement 5: AD directory access (read-only) and credential verification

**User Story:** As an operator, I want my AD credentials verified live against the directory, so that access reflects current AD state and no directory password is stored in NetOps.

#### Acceptance Criteria

1. THE Directory_Provider SHALL perform only LDAP bind and search operations against AD and SHALL NOT perform any add, modify, delete, moddn, or other write operation.
2. WHEN a login is routed to AD, THE Directory_Provider SHALL bind the Service_Account, search within `AD_BASE_DN` for the identifier, and — only when exactly one entry is found — bind that entry's DN with the supplied password.
3. THE Directory_Provider SHALL build the user search filter as `(&(objectClass=user)(|(sAMAccountName=<id>)(userPrincipalName=<id>)(mail=<id>)))`, escaping the identifier per RFC 4515 as untrusted input.
4. IF the search returns zero or more than one entry, OR the User_Bind fails because the password is wrong, THEN THE Auth_Service SHALL reject the attempt as generic invalid credentials.
5. THE NetOps_Policy_Manager SHALL never persist an AD user's password or hash; `users.password_hash` SHALL remain null for AD accounts, and the password SHALL be verified against AD on every login.
6. THE Directory_Provider SHALL apply the bounded `AD_TIMEOUT_MS` connect/operation timeout and SHALL release the connection after each attempt.
7. THE Directory_Provider SHALL never log the `AD_BIND_PASSWORD` or any user-supplied password.

### Requirement 6: JIT provisioning on first AD login

**User Story:** As an AD user, I want my NetOps account created automatically on first login, so that I can start without a manual account request.

#### Acceptance Criteria

1. WHEN an AD User_Bind succeeds AND no NetOps user matches the entry's External_Id, THE Auth_Service SHALL create a `users` row with `auth_provider = 'AD'`, `password_hash = null`, and `role_id = null`.
2. THE Auth_Service SHALL map directory attributes to NetOps fields as: `external_id` ← `objectGUID` (canonical GUID string), `email` ← `userPrincipalName` (lowercased), `display_name` ← `displayName` else `cn`, `username` ← `sAMAccountName` (lowercased).
3. WHEN an AD User_Bind succeeds AND a NetOps user already matches the External_Id, THE Auth_Service SHALL reuse the existing user and SHALL NOT create a duplicate.
4. THE Auth_Service SHALL recognize a returning AD user by `external_id` rather than by email or display name.
5. WHEN a returning AD user logs in, THE Auth_Service SHALL refresh mutable directory-sourced fields (`email`, `display_name`, `username`, backfilling `username` where previously absent) without changing `external_id`, `role_id`, or `is_active`, and SHALL update `last_login_at` on successful login.
6. WHERE a newly provisioned AD user has `role_id = null`, THE Authorization_Service SHALL treat the user as holding no feature permissions (common access: Dashboard and Log Trail only), per the `rbac-permissions/` spec.

### Requirement 7: Second factor (NetOps-managed TOTP)

**User Story:** As any user, I want the same TOTP second factor regardless of provider, so that login is consistent and secure.

#### Acceptance Criteria

1. THE MFA second factor SHALL be managed entirely within NetOps for both LOCAL and AD users; the second factor SHALL NOT be delegated to AD.
2. WHEN a user begins enrollment, THE Auth_Service SHALL generate a TOTP secret, store it AES-256-GCM-encrypted (keyed by `MFA_ENCRYPTION_KEY`), and return the `otpauth` URI only so the client can render the QR code.
3. THE Auth_Service SHALL mark an enrollment enabled only after the user confirms it with a valid TOTP code.
4. WHEN verifying the second factor at login, THE Auth_Service SHALL accept a code that matches ANY of the user's enabled devices; pending (unconfirmed) enrollments SHALL NOT count.
5. THE Auth_Service SHALL allow a user up to two confirmed TOTP devices, enforced in the service layer (the schema intentionally has no unique index on `user_id`).
6. THE Auth_Service SHALL refuse to remove a user's last confirmed device.
7. THE MFA_Challenge SHALL be a short-lived signed cookie (TTL `MFA_CHALLENGE_TTL_MINUTES`), carrying the user id and purpose; it SHALL NOT be a database table, and the session SHALL be created only after the second factor tied to the challenge succeeds.
8. THE Auth_Service SHALL never return a TOTP secret to the client except within the enrollment `otpauth` URI.

### Requirement 8: Server-side session

**User Story:** As an operator, I want a secure server-side session, so that only a valid, unexpired session grants access.

#### Acceptance Criteria

1. WHEN the Auth_Service creates a session, THE Session_Store SHALL persist only the SHA-256 hash of the session token, and THE raw token SHALL be set in an HttpOnly, `SameSite=Lax` cookie (`netops_session`).
2. WHERE the runtime is a Production_Environment (or `COOKIE_SECURE` is true), THE Auth_Service SHALL set the `Secure` attribute on the session cookie; `COOKIE_SECURE=false` MAY disable it for a temporary HTTP-only UAT.
3. WHEN the Auth_Service creates a session, THE Session_Store SHALL record an expiry (`SESSION_TTL_HOURS`) and a last-used timestamp, and WHEN a request is validated THE Auth_Service SHALL refresh the last-used timestamp at most once per throttle window.
4. IF a request presents a token whose session is expired, unknown, or whose user is missing/inactive, THEN THE Auth_Service SHALL reject it (HTTP 401), delete the orphaned session where applicable, and clear the cookie.
5. WHEN a user logs out, THE Session_Store SHALL delete the session row and clear the cookie, and the operation SHALL be idempotent.

### Requirement 9: Error handling and reachability

**User Story:** As an operator, I want distinct, safe feedback for wrong credentials versus an unreachable directory, so that I can tell a password problem from an outage.

#### Acceptance Criteria

1. IF an AD login fails due to no match, an ambiguous match, or a failed User_Bind, THEN THE API_Layer SHALL return HTTP 401 with a generic `INVALID_CREDENTIALS` error that does not distinguish which factor or field was wrong.
2. IF the Directory_Provider cannot reach AD (connection refused, timeout, DNS/host failure, TLS failure, or a failed Service_Account bind), THEN THE API_Layer SHALL return HTTP 503 with `AD_UNREACHABLE` and a safe code identifier (e.g. `ECONNREFUSED`, `ETIMEDOUT`, or `SERVICE_BIND_FAILED`).
3. THE directory-unreachable response SHALL NOT include the bind DN, the bind password, user passwords, raw LDAP messages, stack traces, or filesystem paths.
4. THE API_Layer SHALL return the same generic invalid-credentials response for a disabled directory account, an unknown user, and a wrong password, except for the distinct `ACCOUNT_DISABLED` (403) and `AD_UNREACHABLE` (503) cases.
5. WHEN the Auth_Service records authentication outcomes, THE Audit_Service SHALL record them per the two-row AUTH model in the `log-trail/` spec, never storing a password or the submitted code.

### Requirement 10: Administrator bootstrap and production posture

**User Story:** As a developer operating the system, I want a clear way to obtain the first administrator, so that an AD-only production still has an initial admin.

#### Acceptance Criteria

1. WHERE the runtime is development, THE NetOps_Policy_Manager MAY retain the seeded LOCAL admin account (from `SEED_USER_*`) for trial and break-glass use.
2. WHERE the runtime is a Production_Environment, THE NetOps_Policy_Manager SHALL be operable with all users sourced from AD and SHALL NOT depend on a LOCAL account to function.
3. THE first administrator in a fully AD-based deployment SHALL be established by an operator assigning the `ADMINISTRATOR` role to an already-provisioned AD user directly in the database, after that user has logged in at least once (see the `rbac-permissions/` spec).
4. THE NetOps_Policy_Manager SHALL NOT grant any role automatically on AD provisioning; every AD user SHALL start with `role_id = null`.

## Non-Functional Requirements

### Security

1. THE NetOps_Policy_Manager SHALL never store any AD user's password or a hash of it.
2. THE Directory_Provider SHALL exclude the bind password, user passwords, and raw directory credential attributes from all logs, audit entries, and client responses.
3. THE NetOps_Policy_Manager SHALL enforce the disabled-account gates and provider routing on the server, independent of any client behavior.
4. THE Directory_Provider SHALL treat directory data as untrusted input, escape the LDAP filter, and map attributes into NetOps fields via explicit server-side logic.
5. WHERE production requires it, THE AD connection SHALL be capable of LDAPS/TLS by setting an `ldaps://` URL in `AD_URL`, with no code change.
6. THE NetOps_Policy_Manager SHALL store TOTP secrets only AES-256-GCM-encrypted and SHALL store only session token hashes.

### Reliability

1. THE Directory_Provider SHALL fail fast on an unreachable directory via the bounded `AD_TIMEOUT_MS` and SHALL surface a distinct unreachable error rather than a generic failure.
2. THE AD login path SHALL not degrade the LOCAL login path when `AD_ENABLED` is false.

### Maintainability

1. THE AD provider SHALL be implemented behind a provider abstraction so LOCAL and AD share one login pipeline, reusing the second factor and session code unchanged.

## Configuration

Validated by the Zod `EnvSchema` at startup (see the `general/` spec, Requirement 7).

| Variable | Rule | Purpose |
|---|---|---|
| `AUTH_LOCAL_ENABLED` | boolean, default `true` | Enables LOCAL logins; set `false` for AD-only production. |
| `AD_ENABLED` | boolean, default `false` | Master switch for the AD provider. |
| `AD_URL` | string; required when `AD_ENABLED` | Directory endpoint (e.g. `ldap://host:389`, or `ldaps://` for TLS). |
| `AD_BASE_DN` | string; required when `AD_ENABLED` | Search subtree root. |
| `AD_BIND_DN` | string; required when `AD_ENABLED` | Service_Account for the search bind. |
| `AD_BIND_PASSWORD` | string; required when `AD_ENABLED` | Service_Account password (operator-supplied). |
| `AD_TIMEOUT_MS` | number, default `5000` | Bounded connect/operation timeout. |
| `SESSION_SECRET` | string, min 32 chars | Signs the MFA challenge cookie. |
| `SESSION_TTL_HOURS` | number, default `8` | Session lifetime and session cookie max-age. |
| `MFA_CHALLENGE_TTL_MINUTES` | number, default `5` | MFA challenge cookie lifetime. |
| `MFA_ENCRYPTION_KEY` | 64 hex chars (32 bytes) | AES-256-GCM key for TOTP secrets at rest. |
| `COOKIE_SECURE` | `true`/`false`, optional | Overrides the `Secure` cookie flag (defaults to true in production). |

## Phase-1 discovery capture (COMPLETED & REMOVED — history only)

The AD provider was delivered in two phases. **Both are complete.**

- **Phase 1 — Discovery (done, then removed).** A development-only, flag-gated
  (`AD_CAPTURE`) mechanism wrote a real returning user's raw directory entry to a
  local, git-ignored file so the team could fix the attribute mapping from real
  data. After the mapping was decided, all capture scaffolding — the `AD_CAPTURE`
  flag, `server/auth/ad/capture.ts`, the `POST /api/auth/ad-capture` discovery
  endpoint, and the `.ad-capture/` folder — was **deleted**. `AD_CAPTURE` is no
  longer part of the environment schema.
- **Phase 2 — Integration (done).** The AD bind is wired into the Auth_Service:
  resolve the provider, verify the password, JIT-provision or resolve by
  `external_id`, then rejoin the shared MFA → session path. A nullable
  `username` column (partial unique index where not null) was added to `users`
  via a committed migration.

This section is retained only as a record of the completed discovery step; the
capture mechanism is NOT current behavior and SHALL NOT be reintroduced.

## Out of Scope

1. Writing to or provisioning accounts in Active Directory (NetOps is read-only against AD).
2. Delegating the second factor to AD or any external MFA; TOTP stays NetOps-managed.
3. Group-based or directory-driven automatic role assignment (roles are assigned via the RBAC model).
4. SSO protocols (Kerberos, SAML, OIDC) and passwordless/certificate authentication.
5. Full-directory sync; AD users are provisioned just-in-time on first login.
6. A UI for editing AD connection settings; the connection is configured via environment variables.
7. Keeping the Phase-1 capture mechanism as a permanent feature.
