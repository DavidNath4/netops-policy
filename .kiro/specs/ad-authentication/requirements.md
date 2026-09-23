# Requirements Document — Active Directory Authentication

## Introduction

This spec defines **Active Directory (AD / LDAP) authentication** for NetOps Policy Manager. Today the application authenticates only LOCAL accounts (email + Argon2 password) followed by a NetOps-managed TOTP second factor. The database schema already anticipates AD (`users.auth_provider` enum `LOCAL | AD`, nullable `users.password_hash`, unique `users.external_id`), but no runtime code binds to a directory.

This spec adds AD as a **second first-factor provider** that plugs into the existing pipeline. AD is used **only** to verify a user's identity and password (an LDAP bind). Everything after a successful bind — just-in-time (JIT) user provisioning, the TOTP second factor, session issuance, and role-based authorization — is owned by NetOps exactly as it is for LOCAL users. The MFA and session layers are already provider-agnostic (keyed on `user_id`) and are reused unchanged.

The work proceeds in two phases:

- **Phase 1 — Discovery (temporary).** Establish the AD connection and bind, let a real user log in, and capture the raw directory entry to a local, disposable file so the team can decide the final attribute mapping from real data. The capture mechanism is development-only, flag-gated, and **removed** once the mapping is decided.
- **Phase 2 — Integration.** Finalize the attribute mapping, JIT-provision AD users, and wire the successful AD bind into the existing MFA → session flow.

Scope of this spec:

- A directory provider that performs an LDAP bind and a read-only user search against AD.
- Provider selection (routing) between LOCAL and AD, configurable per environment.
- JIT provisioning of AD users on first login, with no role (common / no feature access) until an administrator assigns one.
- Reuse of the existing TOTP enrollment/verification and session issuance for AD users.
- Environment configuration for the AD connection, added to the existing Zod env schema.
- Error handling that distinguishes wrong credentials from an unreachable directory, and a front-of-flow gate for disabled accounts.
- The temporary Phase-1 capture mechanism and its removal criteria.

## Glossary

- **AD / Active Directory**: The external LDAP directory that authoritatively verifies user identity and password.
- **Directory_Provider**: The server-side component that connects to AD, binds a service account, searches for a user, and verifies the user's password via an LDAP bind. Read-only against the directory.
- **Service_Account**: The AD bind account (`AD_BIND_DN` / `AD_BIND_PASSWORD`) used to connect and search the directory; it never has its password stored by NetOps and is not an application user.
- **User_Bind**: The verification step where the Directory_Provider re-binds to AD using the located user's Distinguished Name (DN) and the password supplied at login, proving the password is correct.
- **JIT_Provisioning**: Creating a NetOps `users` row for an AD user on their first successful login, populated from directory attributes, with `auth_provider = 'AD'`, `password_hash = null`, and `role_id = null`.
- **External_Id**: The immutable AD identifier stored in `users.external_id` (`objectGUID`, formatted as a canonical GUID string), used to recognize a returning AD user regardless of email/name changes.
- **Username**: The AD `sAMAccountName` (e.g. `jdoe`), stored lowercased in `users.username`. An additional login identifier alongside email, not a replacement.
- **Auth_Provider**: The persisted origin of an account: `LOCAL` (email + Argon2 password) or `AD` (directory bind).
- **Provider_Routing**: The server-side decision of which provider (LOCAL or AD) verifies a given login attempt, governed by environment configuration and the identifier.
- **MFA_Challenge**: The existing short-lived, signed pre-auth cookie issued after a successful first factor, carrying the user id and a purpose (`MFA_ENROLLMENT | MFA_LOGIN`).
- **Capture_Mode**: A development-only, flag-gated behavior that writes a returning AD user's raw directory entry to a local disposable file for mapping analysis. Not present in production and removed after Phase 1.
- **Auth_Service**: The existing server component that decides whether a login's first factor succeeds and maps a user row to the safe client shape.
- **Session_Store / Session_Token / MFA**: As defined in the main NetOps Policy Manager spec; reused unchanged for AD users.

## Requirements

### Requirement 1: Directory connection and configuration

**User Story:** As an operator, I want the AD connection configured through validated environment variables, so that the directory endpoint and service account are explicit and never hardcoded.

#### Acceptance Criteria

1. THE Config_Service SHALL validate the AD configuration variables `AD_ENABLED`, `AD_URL`, `AD_BASE_DN`, `AD_BIND_DN`, and `AD_BIND_PASSWORD` as part of the startup environment schema.
2. WHERE `AD_ENABLED` is true, THE Config_Service SHALL require `AD_URL`, `AD_BASE_DN`, `AD_BIND_DN`, and `AD_BIND_PASSWORD` to be present and non-empty, and SHALL halt startup if any is missing.
3. WHERE `AD_ENABLED` is false, THE Config_Service SHALL allow the remaining AD variables to be absent.
4. THE Config_Service SHALL validate the LOCAL provider toggle `AUTH_LOCAL_ENABLED` (default true in development) that enables or disables LOCAL logins.
5. THE NetOps_Policy_Manager SHALL provide `.env.example` placeholder entries for every AD variable without any real credentials.
6. THE Directory_Provider SHALL NOT log the `AD_BIND_PASSWORD` or any user-supplied password.
7. THE Directory_Provider SHALL connect to AD only at the address given by `AD_URL` and SHALL search only within the subtree rooted at `AD_BASE_DN`.

### Requirement 2: Read-only directory access

**User Story:** As a security administrator, I want NetOps to only read from the directory, so that authentication can never modify AD.

#### Acceptance Criteria

1. THE Directory_Provider SHALL perform only LDAP bind and search operations against AD.
2. THE Directory_Provider SHALL NOT perform any add, modify, delete, moddn, or other write operation against AD.
3. THE Directory_Provider SHALL bind the Service_Account only to search for the user and SHALL bind the user's DN only to verify the user's password.
4. THE Directory_Provider SHALL close or release each directory connection after the authentication attempt completes.

### Requirement 3: Provider routing (LOCAL vs AD)

**User Story:** As a developer, I want the application to decide which provider verifies a login, so that development can use both LOCAL and AD accounts while production uses AD only.

#### Acceptance Criteria

1. WHERE `AUTH_LOCAL_ENABLED` is true, THE Auth_Service SHALL allow a login attempt matching a persisted LOCAL account to be verified by the LOCAL provider.
2. WHERE `AD_ENABLED` is true, THE Auth_Service SHALL allow a login attempt for an unknown identifier or a persisted AD account to be verified by the AD provider.
3. WHEN an identifier matches an existing user whose `auth_provider` is `LOCAL`, THE Auth_Service SHALL route the attempt to the LOCAL provider.
4. WHEN an identifier matches an existing user whose `auth_provider` is `AD`, THE Auth_Service SHALL route the attempt to the AD provider.
5. WHEN an identifier matches no existing user AND `AD_ENABLED` is true, THE Auth_Service SHALL route the attempt to the AD provider.
6. WHERE `AD_ENABLED` is false AND `AUTH_LOCAL_ENABLED` is true, THE Auth_Service SHALL behave exactly as the current LOCAL-only system.
7. WHERE a production configuration sets `AUTH_LOCAL_ENABLED` to false, THE Auth_Service SHALL reject every LOCAL login attempt and SHALL authenticate only through AD.
8. THE Auth_Service SHALL make the provider-routing decision on the server only, and SHALL NOT accept a client-supplied provider selection.
9. THE Auth_Service SHALL accept a login identifier that is either an AD username (`sAMAccountName`) or an email/UPN, and SHALL resolve an existing account for routing by matching the identifier against the stored `email` or `username`.

### Requirement 4: Disabled account gate (front of flow)

**User Story:** As a security administrator, I want a locally disabled account stopped before any directory call, so that a suspended user cannot authenticate and receives a clear message.

#### Acceptance Criteria

1. WHEN a login identifier matches an existing NetOps user whose `is_active` is false, THE Auth_Service SHALL reject the attempt before performing any AD bind.
2. WHEN the Auth_Service rejects a login because the account is disabled, THE API_Layer SHALL return an error code that the Frontend renders as an "account is disabled — please contact your administrator" message.
3. THE Auth_Service SHALL apply the disabled-account gate to both LOCAL and AD accounts.
4. THE Auth_Service SHALL NOT reveal, in the disabled-account response, any directory detail or whether the supplied password was correct.

### Requirement 5: AD credential verification

**User Story:** As an operator, I want my AD username and password verified against the directory at every login, so that access always reflects current AD credentials and no directory password is stored in NetOps.

#### Acceptance Criteria

1. WHEN a login attempt is routed to the AD provider, THE Directory_Provider SHALL bind the Service_Account, search for the user by the supplied identifier within `AD_BASE_DN`, and — if exactly one entry is found — bind that entry's DN with the supplied password.
2. WHEN the User_Bind succeeds, THE Directory_Provider SHALL treat the first factor as verified and SHALL return the located directory entry to the Auth_Service.
3. IF the directory search returns no entry or more than one entry, THEN THE Auth_Service SHALL reject the attempt as invalid credentials.
4. IF the User_Bind fails because the password is wrong, THEN THE Auth_Service SHALL reject the attempt as invalid credentials.
5. THE NetOps_Policy_Manager SHALL NOT persist any AD user's password or password hash; `users.password_hash` SHALL remain null for AD accounts.
6. THE Directory_Provider SHALL verify the password against AD on every AD login and SHALL NOT rely on any previously stored value to skip the bind.
7. IF the located directory entry is disabled in AD (the `ACCOUNTDISABLE` bit of `userAccountControl` is set), THEN THE Directory_Provider SHALL reject the attempt with a distinct account-disabled outcome (mapped to 403) before the User_Bind, independently of the NetOps `is_active` gate.

### Requirement 6: JIT provisioning on first AD login

**User Story:** As an operator, I want my NetOps account created automatically the first time I log in through AD, so that I can start using the app without a manual account request.

#### Acceptance Criteria

1. WHEN an AD User_Bind succeeds AND no NetOps user matches the entry's External_Id, THE Auth_Service SHALL create a new `users` row with `auth_provider = 'AD'`, `password_hash = null`, and `role_id = null`.
2. THE Auth_Service SHALL populate the new AD user's `external_id` (from `objectGUID`), `email` (from `userPrincipalName`), `display_name` (from `displayName`, else `cn`), and `username` (from `sAMAccountName`) from the directory entry.
3. WHEN an AD User_Bind succeeds AND a NetOps user already matches the entry's External_Id, THE Auth_Service SHALL use the existing user and SHALL NOT create a duplicate.
4. THE Auth_Service SHALL recognize a returning AD user by `external_id` rather than by email or display name.
5. WHEN a returning AD user logs in, THE Auth_Service SHALL update the user's `last_login_at`, and MAY refresh mutable directory-sourced fields (`email`, `display_name`, `username` — backfilling `username` where it was previously absent) without changing `external_id`, `role_id`, or `is_active`.
6. WHERE a newly provisioned AD user has `role_id = null`, THE Authorization_Service SHALL treat the user as holding no feature Permissions (common access: Dashboard and Log Trail only), consistent with the RBAC spec.
7. THE Auth_Service SHALL perform JIT provisioning only after a successful User_Bind, and SHALL NOT create a user for a failed or ambiguous authentication.

### Requirement 7: Second factor and session for AD users

**User Story:** As an AD user, I want the same TOTP second factor and session behavior as any other user, so that login is consistent and secure regardless of provider.

#### Acceptance Criteria

1. WHEN an AD first factor succeeds for a user without a confirmed MFA device, THE Auth_Service SHALL issue an MFA_Challenge with purpose `MFA_ENROLLMENT` and SHALL return the `MFA_SETUP_REQUIRED` status.
2. WHEN an AD first factor succeeds for a user with a confirmed MFA device, THE Auth_Service SHALL issue an MFA_Challenge with purpose `MFA_LOGIN` and SHALL return the `MFA_REQUIRED` status.
3. THE NetOps_Policy_Manager SHALL manage the TOTP second factor entirely within NetOps for AD users, using the existing enrollment and verification flow, and SHALL NOT delegate the second factor to AD.
4. WHEN an AD user completes the TOTP second factor, THE Auth_Service SHALL create the authenticated session using the existing session issuance, storing only the session token hash.
5. THE AD login flow SHALL NOT create a session before the second factor succeeds.
6. THE MFA enrollment, verification, device-management, and session-issuance behavior for AD users SHALL be identical to the LOCAL flow, differing only in the first factor.

### Requirement 8: Error handling and reachability

**User Story:** As an operator, I want distinct, safe feedback for wrong credentials versus a directory that cannot be reached, so that I can tell a password problem from an outage.

#### Acceptance Criteria

1. IF an AD login fails due to no matching entry, an ambiguous match, or a failed User_Bind, THEN THE API_Layer SHALL return HTTP 401 with a generic invalid-credentials error that does not distinguish which factor or field was wrong.
2. IF the Directory_Provider cannot reach AD (connection refused, timeout, TLS failure, or the Service_Account bind fails), THEN THE API_Layer SHALL return an HTTP 503 error indicating the directory is unreachable, including a safe error identifier (e.g. the connection error code such as `ECONNREFUSED` or `ETIMEDOUT`).
3. THE directory-unreachable response SHALL NOT include internal detail such as stack traces, the bind DN, the bind password, filesystem paths, or raw LDAP server messages.
4. THE Directory_Provider SHALL apply a bounded connection and operation timeout so that an unresponsive directory fails fast rather than hanging the request.
5. WHEN the Auth_Service records authentication outcomes, THE Audit_Service SHALL record LOGIN_SUCCESS and LOGIN_FAILED entries for AD attempts consistent with LOCAL attempts, without recording any password.
6. THE API_Layer SHALL return the same generic invalid-credentials response for a disabled directory account, an unknown user, and a wrong password, except for the distinct disabled-account and directory-unreachable cases defined above.

### Requirement 9: Phase-1 discovery capture (temporary)

**User Story:** As a developer, I want to capture the raw AD entry of a real login during discovery, so that the team can decide the final attribute mapping from real data before writing provisioning code.

#### Acceptance Criteria

1. WHERE `AD_CAPTURE` is true AND the runtime is not a Production_Environment, THE Directory_Provider MAY write the located raw directory entry to a local file for analysis.
2. THE Capture_Mode SHALL write only directory attributes returned by the search and SHALL exclude any user-supplied password and any credential attribute (e.g. `unicodePwd`, `userPassword`), redacting such fields if present.
3. THE Capture_Mode SHALL write capture files only to a local, git-ignored location and SHALL NOT transmit captured data anywhere.
4. WHERE `AD_CAPTURE` is false OR the runtime is a Production_Environment, THE Directory_Provider SHALL NOT write any capture file.
5. THE Capture_Mode SHALL be treated as temporary scaffolding and SHALL be removed from the codebase, together with the `AD_CAPTURE` variable, once the attribute mapping is decided.
6. THE Capture_Mode SHALL NOT change the authentication outcome; capturing SHALL be a side effect only.

### Requirement 10: Administrator bootstrap and production posture

**User Story:** As a developer operating the system, I want a clear way to obtain the first administrator, so that a fully AD-based production still has an initial admin.

#### Acceptance Criteria

1. WHERE the runtime is development, THE NetOps_Policy_Manager MAY retain the seeded LOCAL admin account (from `SEED_USER_*`) for trial and break-glass use.
2. WHERE the runtime is a Production_Environment, THE NetOps_Policy_Manager SHALL be operable with all users sourced from AD and SHALL NOT depend on a LOCAL account to function.
3. THE first administrator in a fully AD-based deployment SHALL be established by an operator assigning the `ADMINISTRATOR` role to an already-provisioned AD user directly in the database, after that user has logged in at least once.
4. THE NetOps_Policy_Manager SHALL NOT grant any role automatically on AD provisioning; every AD user SHALL start with `role_id = null` until an administrator assigns a role.
5. THE role-assignment process for AD users SHALL use the same data-driven RBAC model as LOCAL users (assigning exactly one role via `users.role_id`).

## Non-Functional Requirements

### Security

1. THE NetOps_Policy_Manager SHALL never store any AD user's password or a hash of it.
2. THE Directory_Provider SHALL exclude the bind password, user passwords, and raw directory credential attributes from all logs, audit entries, captures, and client responses.
3. THE NetOps_Policy_Manager SHALL enforce the disabled-account gate and provider routing on the server, independent of any client behavior.
4. THE Directory_Provider SHALL treat directory data as untrusted input and SHALL validate and map it into NetOps fields via explicit server-side logic.
5. WHERE production requires it, THE AD connection SHALL be capable of using LDAPS/TLS through configuration without code changes to the provider abstraction.

### Reliability

1. THE Directory_Provider SHALL fail fast on an unreachable directory via bounded timeouts and SHALL surface a distinct unreachable error rather than a generic failure.
2. THE AD login path SHALL not degrade the existing LOCAL login path when `AD_ENABLED` is false.

### Maintainability

1. THE AD provider SHALL be implemented behind a provider abstraction so LOCAL and AD share one login pipeline and the second factor and session code are reused unchanged.
2. THE Phase-1 capture scaffolding SHALL be isolated and clearly marked so it can be removed cleanly without affecting the integrated flow.

## Out of Scope

The following are explicitly NOT part of this spec:

1. Writing to or provisioning accounts in Active Directory (NetOps is read-only against AD).
2. Delegating the second factor to AD or any external MFA; TOTP remains NetOps-managed.
3. Group-based or directory-driven automatic role assignment; roles are assigned by an administrator via the RBAC model.
4. Single sign-on protocols (Kerberos, SAML, OIDC) and passwordless/certificate authentication.
5. Syncing or importing the full directory; users are provisioned just-in-time on their own first login.
6. A UI for editing AD connection settings; the connection is configured via environment variables.
7. Keeping the Phase-1 capture mechanism as a permanent feature.
