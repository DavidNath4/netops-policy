# Design Document — Active Directory Authentication

## Overview

This document designs **Active Directory (AD / LDAP) authentication** for NetOps Policy Manager and maps to the acceptance criteria in this spec's `requirements.md`.

The core idea is small and deliberate: AD is a **second first-factor provider**. The existing login pipeline already separates the first factor (password verification) from everything after it (MFA challenge → TOTP → session). Those later stages are keyed purely on `user_id` and are provider-agnostic. So AD integration adds one thing — a way to verify identity + password against the directory and resolve it to a NetOps `users` row — and then rejoins the existing flow at exactly the point where the LOCAL path already issues an MFA challenge.

Nothing about MFA, sessions, cookies, or RBAC changes. The database is already AD-ready (`auth_provider` enum, nullable `password_hash`, unique `external_id`). The LDAP client (`ldapts`) is already installed. This is additive work, not a refactor.

Design goals:

- **Reuse the pipeline** — after a successful AD bind, reuse the existing `issueMfaChallenge → mfa/verify → createSession` path unchanged (Req 7).
- **Read-only directory** — bind + search only; never write to AD (Req 2).
- **Server-authoritative routing** — the server decides LOCAL vs AD; the client cannot choose (Req 3.8).
- **Fail-safe, distinguishable errors** — wrong credentials look generic; an unreachable directory is a distinct, informative 503 (Req 8).
- **Discovery before commitment** — Phase 1 captures a real directory entry to a disposable file, then that scaffolding is removed (Req 9).
- **Provider abstraction** — LOCAL and AD implement one small interface so the pipeline is provider-neutral (NFR Maintainability 1).

## Two-phase delivery

This spec was intentionally split so implementation was directed and low-risk. **Both phases are complete.**

- **Phase 1 — Discovery (done, then removed).** Built the connection, Service_Account bind, and user search; a real user logged in and the located entry was written to a local, git-ignored file. The team read it and fixed the attribute mapping (immutable id `objectGUID`, email `userPrincipalName`, display name `displayName`, username `sAMAccountName`). The flag-gated capture code was then **deleted** (Req 9.5).
- **Phase 2 — Integration (done).** With the mapping fixed, the AD bind is wired into the Auth_Service: route the attempt, verify the password, JIT-provision or resolve the user by `external_id`, then issue the MFA challenge — plus the disabled-account gate (NetOps `is_active` and AD `ACCOUNTDISABLE`). A `username` column was added to `users` (via migration) so users can log in by AD username as well as email. All Phase-1 capture scaffolding was removed.

The requirements describe the integrated system as it now stands; Phase 1 was the means to fix the one unknown (the attribute mapping) from real data rather than by guessing.

## Architecture

### Where AD plugs into the existing flow

The current LOCAL flow (unchanged code shown for context):

```
POST /api/auth/login
  → verifyLocalCredentials(db, email, password)      [argon2 verify]
  → findMfaByUserId → issueMfaChallenge(...)          [MFA_ENROLLMENT | MFA_LOGIN]
  → { status: MFA_SETUP_REQUIRED | MFA_REQUIRED }

POST /api/auth/mfa/verify
  → verifyMfaLogin → createSession → updateLastLogin
  → { status: AUTHENTICATED, user }
```

The AD flow rejoins at `issueMfaChallenge`:

```
POST /api/auth/login
  → resolveProvider(identifier)                        [LOCAL | AD | reject]
  → disabled-account gate (existing user & !is_active → stop)   (Req 4)
  ├─ LOCAL → verifyLocalCredentials(...)               [unchanged]
  └─ AD    → verifyAdCredentials(identifier, password) [bind + search + user-bind]
             → resolveOrProvisionAdUser(entry)          [findByExternalId | create]  (Req 6)
  → findMfaByUserId → issueMfaChallenge(...)            [SHARED join point]
  → { status: MFA_SETUP_REQUIRED | MFA_REQUIRED }

POST /api/auth/mfa/verify                                [UNCHANGED for both providers]
  → verifyMfaLogin → createSession → updateLastLogin
  → { status: AUTHENTICATED, user }
```

The only new server logic lives before `issueMfaChallenge`. Everything from the MFA challenge onward is the existing code path.

### Request flow (login, both providers)

```mermaid
flowchart TD
    A[POST /api/auth/login<br/>identifier + password] --> B{resolveProvider}
    B -->|existing LOCAL user| L[verifyLocalCredentials]
    B -->|existing AD user / unknown & AD_ENABLED| G0[disabled-account gate]
    L --> G0
    G0 -->|is_active = false| DIS[reject: ACCOUNT_DISABLED]
    G0 -->|ok| P{provider}
    P -->|LOCAL| LR[argon2 verify]
    P -->|AD| AD1[bind service account]
    AD1 --> AD2[search user in BASE_DN]
    AD2 -->|0 or >1| INV[reject: INVALID_CREDENTIALS 401]
    AD2 -->|exactly 1| AD3[bind user DN + password]
    AD3 -->|bind fails| INV
    AD3 -->|unreachable| UNR[AD_UNREACHABLE 503 + code]
    AD3 -->|ok| PROV[resolve by external_id<br/>or JIT provision]
    LR --> CH
    PROV --> CH[issueMfaChallenge]
    CH --> OUT[MFA_SETUP_REQUIRED | MFA_REQUIRED]
```

### Provider abstraction

A minimal interface so the pipeline stays provider-neutral. Both providers return a resolved NetOps user (the safe response shape) on success and throw a typed error otherwise.

```typescript
// server/auth/provider.ts (new)
export interface FirstFactorResult {
  user: UserResponse           // resolved NetOps user (existing safe shape)
}

export interface AuthProvider {
  readonly kind: 'LOCAL' | 'AD'
  // Verify identity + password (first factor). Throws AuthError (generic) on
  // bad credentials; throws DirectoryUnreachableError for AD outages.
  verify(db: Database, identifier: string, password: string): Promise<FirstFactorResult>
}
```

- **LocalAuthProvider** wraps the existing `verifyLocalCredentials` — no behavior change.
- **AdAuthProvider** wraps the Directory_Provider bind/search/user-bind plus `resolveOrProvisionAdUser`.

`login.post.ts` selects the provider via `resolveProvider(...)` and calls `provider.verify(...)`, then continues to the shared MFA-challenge step. This keeps the endpoint thin and the decision on the server (Req 3.8).

## Components and Interfaces

### Directory provider (`server/auth/ad/`) — Req 1, 2, 5, 8

A small module around `ldapts` (already installed). Responsibilities:

- **connect** — open a client to `AD_URL` with a bounded timeout (Req 8.4).
- **bindService** — bind `AD_BIND_DN` / `AD_BIND_PASSWORD`; a failure here is treated as *unreachable/misconfigured*, not as a user credential error (Req 8.2).
- **searchUser** — search within `AD_BASE_DN` for the identifier (see filter below); require exactly one entry (Req 5.1, 5.3).
- **bindUser** — bind the located entry's DN with the supplied password to verify it (Req 5.1, 5.4).
- **teardown** — always unbind/close the connection (Req 2.4).

```typescript
// server/auth/ad/directory.ts (new) — read-only, bind + search only (Req 2)
export interface DirectoryEntry {
  dn: string
  attributes: Record<string, string | string[]>   // raw, as returned by AD
}

export interface DirectoryProvider {
  // Returns the located entry when the user's own bind succeeds; throws
  // AuthError for 0/>1 matches or a failed user bind; throws
  // DirectoryUnreachableError when AD cannot be reached / service bind fails.
  authenticate(identifier: string, password: string): Promise<DirectoryEntry>
}
```

Never logs `AD_BIND_PASSWORD` or the user password (Req 1.6, NFR Sec 2). Performs no write operation (Req 2.2).

### Identifier and search filter — Req 5 (FINALIZED)

By design the login identifier is flexible: a user may enter their AD **username** (`sAMAccountName`, e.g. `jdoe`) **or** their **email/UPN** (`jdoe@mov.co.id`). The directory search matches the supplied identifier against the common candidate attributes with a single read-only filter:

```
(&(objectClass=user)(|(sAMAccountName=<id>)(userPrincipalName=<id>)(mail=<id>)))
```

The identifier value is escaped per RFC 4515 before being placed in the filter (untrusted input, NFR Sec 4). If the filter matches more than one entry, the attempt is rejected as invalid credentials (Req 5.3) — the system never guesses among multiple matches.

`LoginSchema` was relaxed from an email-only field to a general `identifier` string (min 1, max 255, no email-format constraint) so both forms are accepted. Provider routing and the provider itself decide validity: LOCAL looks the identifier up as an email; AD searches the directory. The login form field is labelled "Username or email".

### Attribute mapping — Req 6.2 (FINALIZED)

Phase-1 discovery confirmed the directory shape against a real entry, and the mapping is now fixed in `resolveOrProvisionAdUser`:

| NetOps column | AD attribute | Notes |
|---|---|---|
| `external_id` | `objectGUID` | Immutable; the recognition key for returning users (Req 6.4). Stored as the canonical GUID string (AD stores it mixed-endian; the provider formats it, e.g. `6c765573-d4e4-4d58-b4cc-465ebd6c41d2`). |
| `email` | `userPrincipalName` | The captured directory has no `mail` attribute; UPN (e.g. `jdoe@mov.co.id`) is used and satisfies the NetOps email constraint. Stored lowercased. |
| `display_name` | `displayName`, else `cn` | Human-friendly name. |
| `username` | `sAMAccountName` | AD short username (e.g. `jdoe`). Stored lowercased. An additional login identifier alongside email (see Req 3), shown in the profile. Backfilled on the next login of accounts provisioned before this column existed. |
| `auth_provider` | — | Constant `'AD'`. |
| `password_hash` | — | Always `null` for AD (Req 5.5). |
| `role_id` | — | Always `null` on provisioning (Req 6.1, 10.4). |

### Auth service changes (`server/services/auth.service.ts`) — Req 3, 4, 5, 6

New/changed functions (LOCAL functions unchanged):

- `resolveProvider(existingProvider, env)` — decides the provider for an attempt. The login handler first looks up any existing account by email **or** username (`findByEmailOrUsername`); an existing `LOCAL` account routes to LOCAL (when `AUTH_LOCAL_ENABLED`), an existing `AD` account routes to AD (when `AD_ENABLED`), and an unknown identifier prefers AD when enabled, else LOCAL. Server-only (Req 3.1–3.8).
- Front-of-flow gate: if the looked-up existing user is `is_active = false`, the handler returns `ACCOUNT_DISABLED` (403) **before** verifying credentials (Req 4.1–4.4). Because the lookup can miss when an AD user logs in by `sAMAccountName` (their stored identifier is the email), `verifyAdCredentials` re-checks `is_active` after the bind for that case.
- `verifyAdCredentials(db, identifier, password)` — calls `authenticateAd`, then `resolveOrProvisionAdUser`; returns the safe user shape (Req 5.2).
- `resolveOrProvisionAdUser(db, entry)` — maps the entry, finds the user by `external_id` (objectGUID); if found, honors the disabled gate, refreshes mutable fields (`email`, `display_name`, `username` — backfilling username where absent) and returns it; if not, inserts a new AD user with `role_id = null` (Req 6.1–6.7).

The directory provider additionally rejects an account **disabled in AD** (the `ACCOUNTDISABLE` bit, `0x2`, of `userAccountControl`) with a distinct `AdAccountDisabledError` → 403, before the user bind. This is separate from the NetOps `is_active` gate (Req 4).

### Repository changes (`server/repositories/user.repository.ts`) — Req 6

Add (LOCAL methods unchanged):

- `findByExternalId(db, externalId)` — the returning-user lookup by objectGUID (Req 6.3, 6.4).
- `findByEmailOrUsername(db, identifier)` — login lookup for routing + the disabled gate, matching either stored identifier.
- `createAdUser(db, { externalId, email, displayName, username })` — inserts with `authProvider: 'AD'`, `passwordHash: null`, `roleId: null` (Req 6.1, 6.2).
- `updateAdProfile(db, userId, { email, displayName, username })` + reuse of `updateLastLogin` for the returning path (Req 6.5).

**Schema change (applied via migration):** a nullable `username varchar(300)` column was added to `users`, with a **partial unique index** (`WHERE username IS NOT NULL`) so the many LOCAL rows with a null username don't collide. The migration was generated via `db:generate` and applied by the operator via `db:migrate` (never automatically). The rest of the `users` table was already AD-ready (`auth_provider`, unique `external_id`, nullable `password_hash`, nullable `role_id`).

### Endpoint impact — Req 7

| Method | Path | Change |
|---|---|---|
| POST | `/api/auth/login` | Adds provider routing, disabled gate, and the AD branch before the shared MFA-challenge step. Response statuses unchanged: `MFA_SETUP_REQUIRED \| MFA_REQUIRED`. |
| POST | `/api/auth/mfa/verify` | **No change.** Creates the session for AD users identically. |
| POST | `/api/auth/mfa/setup`, `/api/auth/mfa/devices/*` | **No change.** AD users enroll TOTP through the existing endpoints. |
| POST | `/api/auth/logout`, GET `/api/auth/me` | **No change.** |

## Configuration

Added to the existing Zod `EnvSchema` (`server/utils/config.ts`), validated at startup by the existing `validate-env` plugin (Req 1.1–1.4). No `runtimeConfig` is introduced; AD config is server-only.

| Variable | Type / rule | Purpose |
|---|---|---|
| `AD_ENABLED` | boolean, default `false` | Master switch for the AD provider (Req 3.2, 3.6). |
| `AUTH_LOCAL_ENABLED` | boolean, default `true` | Enables LOCAL logins; set `false` in AD-only production (Req 3.7). |
| `AD_URL` | string (e.g. `ldap://10.72.151.9:389`); required when `AD_ENABLED` | Directory endpoint (Req 1.2, 1.7). |
| `AD_BASE_DN` | string (e.g. `dc=mov,dc=co,dc=id`); required when `AD_ENABLED` | Search subtree root (Req 1.7). |
| `AD_BIND_DN` | string (e.g. `mov\saconnect`); required when `AD_ENABLED` | Service_Account for search bind. |
| `AD_BIND_PASSWORD` | string; required when `AD_ENABLED` | Service_Account password (operator fills manually). |
| `AD_TIMEOUT_MS` | number, default e.g. `5000` | Bounded connect/operation timeout (Req 8.4). |

> `AD_CAPTURE` was a temporary Phase-1 discovery flag. Phase 1 is complete and the capture scaffolding (flag, capture module, discovery endpoint, and `.ad-capture/` folder) has been **removed** from the codebase (Req 9.5). It is retained in Req 9 below only as a record of the completed discovery step.

Conditional validation: when `AD_ENABLED` is true, `AD_URL` / `AD_BASE_DN` / `AD_BIND_DN` / `AD_BIND_PASSWORD` must be present and non-empty, else startup halts (Req 1.2). When `AD_ENABLED` is false, they may be absent (Req 1.3). LDAPS/TLS is expressed purely by using an `ldaps://` URL in `AD_URL`, so production TLS needs config only, not code (NFR Sec 5).

## Phase-1 capture design (temporary — COMPLETED & REMOVED) — Req 9

> Status: Phase 1 is done. The capture confirmed the attribute mapping (see the finalized mapping table above), and all capture scaffolding — the `AD_CAPTURE` flag, `server/auth/ad/capture.ts`, the `POST /api/auth/ad-capture` discovery endpoint, and the `.ad-capture/` folder + `.gitignore` entry — has been removed. The design below is kept as a record of how discovery worked.

The capture was deliberately small, isolated, and disposable.

- **Trigger.** Only when `AD_CAPTURE` is true **and** `NODE_ENV !== 'production'` (Req 9.1, 9.4).
- **What is written.** The raw `DirectoryEntry.attributes` returned by the search — nothing else. The user's password is never in that object; any credential attribute (`unicodePwd`, `userPassword`, etc.) is redacted before writing (Req 9.2).
- **Where.** A local, git-ignored folder (e.g. `.ad-capture/`), one file per attempt named by timestamp + a non-sensitive identifier. Never transmitted anywhere (Req 9.3). The folder is added to `.gitignore`.
- **Effect.** Capture is a pure side effect; it never changes whether login succeeds (Req 9.6).
- **Isolation & removal.** The capture call sits behind a single guarded function clearly marked as temporary discovery scaffolding, so it (and the `AD_CAPTURE` variable and `.ad-capture/` entry) can be deleted in one step after the mapping is fixed (Req 9.5, NFR Maintainability 2).

## Error handling — Req 8

New typed errors, mapped centrally to the API envelope:

| Condition | Error / code | HTTP | Notes |
|---|---|---|---|
| No match / >1 match / user-bind fails | `INVALID_CREDENTIALS` | 401 | Generic; identical to LOCAL bad-password (Req 8.1, 8.6). |
| Existing account `is_active = false` | `ACCOUNT_DISABLED` | 403 | Front-of-flow, before any AD bind; Frontend shows the "account disabled — contact admin" dialog (Req 4.2). |
| AD unreachable / service bind fails / timeout / TLS | `AD_UNREACHABLE` | 503 | Includes a safe identifier such as the connection error code (`ECONNREFUSED`, `ETIMEDOUT`); no internal detail leaked (Req 8.2, 8.3). |

The disabled-account and unreachable responses are the only two that deviate from the uniform invalid-credentials response (Req 8.6). No response ever includes the bind DN, bind password, user password, LDAP raw messages, stack traces, or paths (Req 8.3, NFR Sec 2). Audit records LOGIN_SUCCESS / LOGIN_FAILED for AD identically to LOCAL, never storing a password (Req 8.5).

## Security considerations

- **No stored directory password.** AD accounts keep `password_hash = null`; the password is verified live at every login and never persisted (Req 5.5, 5.6, NFR Sec 1).
- **Read-only directory.** Only bind + search; no write path exists in the provider (Req 2, NFR Sec — the provider exposes no modify method).
- **Injection-safe search.** The identifier is RFC-4515-escaped before entering the LDAP filter (NFR Sec 4).
- **Secret hygiene.** Bind password and user passwords are excluded from logs, captures, audit, and responses (Req 1.6, 8.3, 9.2, NFR Sec 2).
- **Server-authoritative decisions.** Provider routing and the disabled gate run on the server; the client cannot influence them (Req 3.8, 4, NFR Sec 3).
- **Bounded blast radius on outage.** A directory outage fails fast with a distinct 503 and never silently falls back to a weaker path (Req 8.2, 8.4, NFR Reliability 1).

## Correctness properties

### Property 1: Provider routing is deterministic and server-side

*For any* identifier and environment flags, `resolveProvider` yields `LOCAL` only for an existing LOCAL account with `AUTH_LOCAL_ENABLED` true, and `AD` for an existing AD account or an unknown identifier when `AD_ENABLED` is true, and never reads a client-supplied provider.

**Validates: Requirements 3.1–3.8**

### Property 2: Disabled accounts are stopped before any directory call

*For any* login whose identifier matches an existing user with `is_active = false`, the flow rejects with the disabled-account error and performs no AD bind.

**Validates: Requirements 4.1, 4.3, 4.4**

### Property 3: AD authentication requires exactly one match and a successful user bind

*For any* AD attempt, the first factor succeeds only when the search returns exactly one entry and the user bind with the supplied password succeeds; zero, multiple, or a failed bind all reject as generic invalid credentials.

**Validates: Requirements 5.1, 5.3, 5.4, 8.1**

### Property 4: AD accounts never store a password

*For any* provisioned or updated AD user, `password_hash` is null and no password value is written to the database, logs, audit, or capture files.

**Validates: Requirements 5.5, 5.6, NFR Security 1, 2**

### Property 5: Returning users are recognized by external_id, provisioned once

*For any* two successful logins by the same AD user, the second resolves the existing user by `external_id` and creates no duplicate row; a first-ever login creates exactly one row with `role_id = null`.

**Validates: Requirements 6.1, 6.3, 6.4, 6.7**

### Property 6: The second factor and session are provider-agnostic

*For any* user, after the first factor succeeds the MFA challenge, TOTP verification, and session issuance behave identically whether the provider was LOCAL or AD.

**Validates: Requirements 7.1–7.6**

### Property 7: Unreachable directory is distinct and safe

*For any* AD outage (refused/timeout/TLS/service-bind failure), the response is a 503 unreachable error carrying only a safe error identifier and no internal detail, distinct from the 401 invalid-credentials response.

**Validates: Requirements 8.2, 8.3, 8.4**

### Property 8: Capture is development-only, redacted, and side-effect-free

*For any* runtime, a capture file is written only when `AD_CAPTURE` is true and the environment is non-production, never contains a password or credential attribute, and never alters the authentication outcome.

**Validates: Requirements 9.1, 9.2, 9.4, 9.6**

## Testing strategy

Testing uses Vitest, consistent with the main spec. AD directory calls are mocked (no live directory in unit/integration tests); the DirectoryProvider is injected so tests exercise the Auth_Service branches deterministically.

### Unit tests

- `resolveProvider` routing table across `AUTH_LOCAL_ENABLED` / `AD_ENABLED` and existing/unknown identifiers (Property 1).
- Disabled-account gate short-circuits before any provider call (Property 2).
- AD verification: exactly-one-match required; 0/>1/failed-bind → generic invalid credentials (Property 3).
- `resolveOrProvisionAdUser`: first login creates one `role_id = null` AD user; returning login resolves by `external_id`, no duplicate (Property 5).
- Error mapping: unreachable → 503 with safe code and no leaked detail; bad creds → 401 generic (Property 7).
- Capture guard: writes only when `AD_CAPTURE` true and non-production; redacts credential attributes; never changes outcome (Property 8).
- LDAP filter escaping of a hostile identifier (NFR Sec 4).

### Integration-style tests (handlers with mocked provider/repos)

- `POST /api/auth/login` for an AD identifier returns `MFA_SETUP_REQUIRED` on first login and `MFA_REQUIRED` for a returning user with a confirmed device (Property 6).
- `POST /api/auth/mfa/verify` creates a session for an AD user unchanged (Property 6).
- No password or bind secret appears in any AD login response or audit entry (Property 4).

## Impact on existing specs

- **`netops-policy-manager`** — Requirement 1 (Authentication) and its design are updated to reflect the current reality (email identifier, TOTP MFA between password and session, `auth_provider`, nullable `password_hash`) and to add AD as a provider that reuses MFA/session; the env/config and seeding sections gain the AD variables and the dev/prod admin-bootstrap posture. Detailed AD behavior lives here and is referenced from the main spec.
- **`rbac-permissions`** — clarified that a JIT-provisioned AD user starts with `role_id = null` (common access), and the first administrator in an AD-only deployment is established by an operator assigning `ADMINISTRATOR` directly in the database after first login; the data-driven assignment model is otherwise unchanged.

Unchanged across specs: MFA design, session issuance, network validation, command generation, audit transactionality, packaging.

## Migration & seeding

1. One `users` schema change was applied: a nullable `username varchar(300)` column with a partial unique index (`WHERE username IS NOT NULL`), to store the AD `sAMAccountName`. The migration was generated via `db:generate` and applied by the operator via `db:migrate` (never automatically). The rest of the table was already AD-ready.
2. No new seed data is required for AD; AD users are provisioned just-in-time on first login with `role_id = null`.
3. The initial administrator for an AD-only deployment is set by the operator assigning the `ADMINISTRATOR` role to a first-logged-in AD user directly in the database.

## Out of scope

Same as this spec's `requirements.md`: no writes to AD, no external/delegated MFA, no group-driven role assignment, no SSO protocols, no full-directory sync, no AD-settings UI, and no permanent capture mechanism.
