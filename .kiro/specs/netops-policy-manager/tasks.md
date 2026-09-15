# Implementation Plan: NetOps Policy Manager

## Overview

This plan is organized **foundation-first**. The foundation is the identity core:
**User + Local Authentication + MFA (TOTP)**, delivered end-to-end (database →
server services → HTTP API → frontend) before any feature domain (RBAC, ACL,
Route, Audit, Active Directory) is built on top of it.

The stack is a single Nuxt 4 (Vue 3 + Nitro) fullstack application: TypeScript
strict, Tailwind + Nuxt UI, shared Zod schemas, Drizzle ORM over PostgreSQL,
Argon2id password hashing, otplib v13 TOTP with AES-256-GCM secret encryption,
and server-side sessions stored as SHA-256 token hashes behind an HttpOnly
cookie. The application never provisions a database, never auto-migrates, and
never falls back to an embedded DB.

The frontend UI was built first on static mock data (all screens visible), and
the identity foundation is now being wired underneath it. Feature domains stay
on mock data until their own phase — for now they are only protected by
authentication.

### Development phases

- **Development 1 (current): Identity foundation — User + Local Auth + MFA.**
  LOCAL users, email + password login, TOTP enrollment and verification,
  server-side sessions, HttpOnly cookie, route protection, seed for the first
  dev user. This is the base every later feature depends on.
- **Development 2: Active Directory / external identity.** `auth_provider = AD`
  and `external_id` are already provisioned in the schema but NOT implemented.
- **Later development: feature domains.** RBAC/permissions, ACL policies, routes,
  command generators, audit trail, dashboard aggregates, API for those domains,
  and wiring the still-mock feature pages to real endpoints.

## Tasks

### Phase 0 — Frontend scaffold + mock UI (DONE)

- [x] 1. Minimal scaffold so the UI runs immediately
  - [x] 1.1 Initialize Nuxt project and package manifest
  - [x] 1.2 Configure TypeScript, Nuxt, Tailwind, ESLint, and app root
- [x] 2. Frontend-first: build the full visible UI on mock data
  - [x] 2.1 App shell and layouts (dark sidebar + white header, auth layout)
  - [x] 2.2 Reusable UI components (PageHeader, DataTable, StatusBadge, FormField, dialogs, states, Pagination)
  - [x] 2.3 Mock data layer and stubbed `useApi` composable
  - [x] 2.4 Login and dashboard pages (mock)
  - [x] 2.5 ACL pages (mock)
  - [x] 2.6 Route pages (mock)
  - [x] 2.7 Administration page (mock)
  - [x] 2.8 Log trail page (mock)
  - [x] 2.9 Light-theme hardening — neutralize Nuxt UI dark mode globally in `app/assets/css/tailwind.css`: map the `--ui-*` semantic tokens to the NetOps light tokens (repeated under `:root`, `.light`, and `.dark`), force `color-scheme: light`, and add explicit light scrollbar styling (`scrollbar-color`/`scrollbar-width` + `::-webkit-scrollbar*`) so overlays (Administration, Profile modals) and native chrome never render dark. Remove the per-component `:ui` dark band-aids from the Change Role and Profile modals.
  - _Requirements: 13.7, 13.8, 13.9, 13.10, 13.11_
- [x] 3. Checkpoint — frontend visible on mock data

### Phase 1 — Identity foundation: data layer + auth core (DONE)

- [x] 4. Environment config and startup validation
  - [x] 4.1 `server/utils/config.ts` EnvSchema (NODE_ENV, DATABASE_URL, SESSION_SECRET, MFA_ENCRYPTION_KEY) + `server/plugins/validate-env.ts` (parse env + SELECT 1 at startup). No provisioning, no auto-migrate.
- [x] 5. Database: identity schema, client, first migration
  - [x] 5.1 `database/schema/users.ts` (users + `auth_provider` LOCAL/AD, `external_id` for AD readiness) and `database/schema/user-mfa.ts` (TOTP, encrypted secret, FK cascade), re-exported from `database/schema/index.ts`
  - [x] 5.2 `database/index.ts` postgres.js + Drizzle client factory; `drizzle.config.ts`; generated migration `0000_sharp_gauntlet.sql` (applied by the operator)
- [x] 6. Identity repositories (DB access only)
  - [x] 6.1 `server/repositories/user.repository.ts` (findById, findByEmail, createLocalUser, updateLastLogin, existsByEmail)
  - [x] 6.2 `server/repositories/user-mfa.repository.ts` (findByUserId, create, enable, deleteByUserId)
- [x] 7. Identity crypto + auth-core services
  - [x] 7.1 `server/services/password.service.ts` (Argon2id hash/verify)
  - [x] 7.2 `server/services/mfa.service.ts` (otplib functional TOTP + AES-256-GCM encrypt/decrypt of the secret; key from `MFA_ENCRYPTION_KEY`)
  - [x] 7.3 `server/services/auth.service.ts` (createLocalUser, verifyLocalCredentials with generic error + timing equalization, prepareMfaEnrollment, verifyMfaEnrollment, verifyMfaLogin)
  - [x] 7.4 Shared Zod: `shared/schemas/user.schema.ts`, `auth.schema.ts` (LoginSchema), `mfa.schema.ts` (VerifyMfaSchema)

### Phase 2 — Identity foundation: sessions + auth API + frontend wiring (CURRENT)

Goal: make User + Local Auth + MFA work end-to-end so a user can be seeded, log
in with email + password, set up and verify TOTP, receive an authenticated
session cookie, open protected pages, survive a browser refresh, and log out.

- [ ] 8. Sessions table + migration (generate only)
  - [ ] 8.1 Add `database/schema/sessions.ts` — `session_id` UUID PK, `user_id` UUID NOT NULL FK→users ON DELETE CASCADE, `token_hash` TEXT NOT NULL UNIQUE, `expires_at` TIMESTAMPTZ NOT NULL, `created_at` TIMESTAMPTZ NOT NULL DEFAULT now(), `last_used_at` TIMESTAMPTZ NULL, `source_ip` VARCHAR(64) NULL, `user_agent` VARCHAR(512) NULL; indexes on token_hash (unique), user_id, expires_at. Re-export from schema index. Raw token never stored.
  - [ ] 8.2 Generate the Drizzle migration for `sessions` — **generate only, do not apply** (operator runs `npm run db:migrate`).
  - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, NFR Security 2_

- [ ] 9. Session configuration
  - [ ] 9.1 Extend `EnvSchema` with `SESSION_TTL_HOURS` (default 8) and `MFA_CHALLENGE_TTL_MINUTES` (default 5); add placeholders + `SEED_USER_*` to `.env.example`. Never expose these via `runtimeConfig.public`.
  - _Requirements: 14.1, 14.2, 1.5_

- [ ] 10. Session repository + service
  - [ ] 10.1 `server/repositories/session.repository.ts` (createSession, findByTokenHash, deleteByTokenHash, deleteAllByUserId, updateLastUsed, deleteExpiredSessions) — DB access only.
  - [ ] 10.2 `server/services/session.service.ts` using `node:crypto`: token via `randomBytes(32)` base64url; store only `SHA-256(token)`; createSession, validateSession (expiry + user active + throttled last_used_at), revokeSession, revokeAllUserSessions, hashSessionToken; cookie helpers for `netops_session` (HttpOnly, SameSite=Lax, Secure in production, Path=/, MaxAge from TTL).
  - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, NFR Security 1, NFR Security 2_

- [ ] 11. Pre-auth MFA challenge
  - [ ] 11.1 `server/utils/mfa-challenge.ts` — short-lived, HMAC-signed (via `SESSION_SECRET`) challenge carried in the `netops_mfa_challenge` HttpOnly cookie: `{ userId, purpose: MFA_ENROLLMENT | MFA_LOGIN, expiresAt }`, integrity-verified, TTL from `MFA_CHALLENGE_TTL_MINUTES`. No new table, no JWT library.
  - _Requirements: 1.1_

- [ ] 12. Auth server helpers + envelope
  - [ ] 12.1 `server/utils/envelope.ts` (ok/fail + ErrorCode) and `server/utils/auth.ts` (`getAuthenticatedUser(event)` → user|null via session cookie; `requireAuthenticatedUser(event)` → throws 401). Reusable same-origin/Origin check for auth mutations. No session lookup duplicated per endpoint.
  - _Requirements: 1.7, 1.9, 12.1, 12.2, NFR Security 4_

- [ ] 13. Auth API endpoints
  - [ ] 13.1 `POST /api/auth/login` — validate (LoginSchema), verifyLocalCredentials; generic `INVALID_CREDENTIALS` 401; on success issue an MFA challenge and return `MFA_SETUP_REQUIRED` (no enrollment or disabled enrollment) or `MFA_REQUIRED` (enabled). No session yet.
  - [ ] 13.2 `POST /api/auth/mfa/setup` — requires valid `MFA_ENROLLMENT` challenge; idempotent prepareMfaEnrollment; returns `otpauthUri` (never logged/persisted/sent to storage).
  - [ ] 13.3 `POST /api/auth/mfa/setup/verify` — requires `MFA_ENROLLMENT` challenge; verifyMfaEnrollment; on success enable MFA, clear challenge, create session + cookie, updateLastLogin; returns `AUTHENTICATED` + safe user.
  - [ ] 13.4 `POST /api/auth/mfa/verify` — requires `MFA_LOGIN` challenge; verifyMfaLogin; generic `INVALID_VERIFICATION_CODE` 401; on success clear challenge, create session + cookie, updateLastLogin; returns `AUTHENTICATED` + safe user.
  - [ ] 13.5 `GET /api/auth/me` — resolve session cookie → safe user or 401.
  - [ ] 13.6 `POST /api/auth/logout` — idempotent; delete DB session, clear both cookies; always `{ loggedOut: true }`.
  - _Requirements: 1.1, 1.8, 1.9, 1.10, 1.11, 12.1, 12.2, NFR Security 5_

- [ ] 14. Development seed (create only, do not run)
  - [ ] 14.1 `database/seeds/seed.ts` — create one LOCAL dev user from `SEED_USER_EMAIL` / `SEED_USER_DISPLAY_NAME` / `SEED_USER_PASSWORD`: normalize email, Argon2id via the existing service, `auth_provider = LOCAL`, idempotent (no duplicate), never log the password. Wired to `npm run db:seed`. **Do not run.**
  - _Requirements: 15.3, 15.4, 15.5_

- [ ] 15. Frontend auth wiring
  - [ ] 15.1 `app/composables/useAuth.ts` — state (user, isAuthenticated, isLoading) + login, setupMfa, verifyMfaSetup, verifyMfa, fetchCurrentUser, logout. No token stored; auth state comes from `GET /api/auth/me`.
  - [ ] 15.2 Wire the existing `login.vue` to `POST /api/auth/login`; redirect to `/mfa/setup` (MFA_SETUP_REQUIRED) or `/mfa/verify` (MFA_REQUIRED). No large redesign; don't retain the password after submit.
  - [ ] 15.3 Create `/mfa/setup` — calls `mfa/setup`, shows the otpauth URI for an authenticator app, 6-digit input → `mfa/setup/verify`; on `AUTHENTICATED` redirect `/`. (QR rendering deferred — no new dependency added automatically.)
  - [ ] 15.4 Create `/mfa/verify` — 6-digit input → `mfa/verify`; on success redirect `/`; on invalid/expired challenge redirect `/login`.
  - _Requirements: 13.4, 13.5_

- [ ] 16. Frontend route protection + session lifecycle
  - [ ] 16.1 Global Nuxt middleware `auth`: protected pages (`/`, ACL, Routes, Administration, Logs) require an authenticated user; public pages `/login`, `/mfa/setup`, `/mfa/verify`; authenticated users hitting `/login` go to `/`. No localStorage guard; avoid redirect loops.
  - [ ] 16.2 Wire the existing header Logout to `POST /api/auth/logout`, clear client state, redirect `/login`. Replace mock identity in the header with the real `useAuth()` user. Populate initial auth state via `GET /api/auth/me` on app load.
  - _Requirements: 1.8, 2.7, 13.5_

- [ ] 17. Foundation verification gate
  - [ ] 17.1 Run `npm run typecheck` and `npm run build`; fix until both pass. Do NOT run migration or seed.
  - _Requirements: 17.16_

### Phase 3 — Active Directory / external identity (Development 2, NOT STARTED)

- [ ] 18. Implement `auth_provider = AD` login against external identity using the already-provisioned `external_id`. No AD/LDAP/Entra/SSO code exists yet.

### Phase 4 — Feature domains (LATER, NOT STARTED)

These were described in the original plan and remain on mock data until built on
top of the identity foundation. Kept here for traceability.

- [ ] 19. Shared Zod validation for network primitives, ACL, route, user-admin, audit, pagination/envelope
- [ ] 20. Database schema for feature domains: roles, user_roles, acl_policies, routes, audit_logs (+ enums, indexes) and their migration
- [ ] 21. RBAC: permissions, ROLE_PERMISSIONS, hasPermission, requirePermission, permission-gated sidebar
- [ ] 22. API envelope error handling + central error handler (ZodError → VALIDATION_ERROR, AppError codes, generic INTERNAL_ERROR)
- [ ] 23. Domain mappers, command generators (preview-only), repositories, services (User/Acl/Route/Audit/Dashboard) with per-mutation transactions + audit
- [ ] 24. API handlers for users, ACL, routes, audit, dashboard, health
- [ ] 25. Wire the mock feature pages (dashboard, ACL, routes, administration, logs) to live endpoints
- [ ] 26. Security/audit integration + property tests
- [ ] 27. Docker multi-stage image + README
- [ ] 28. Final full-pipeline verification (typecheck, lint, test, build)

## Notes

- **Foundation-first:** Phase 2 completes the identity core end-to-end before any
  feature domain. RBAC/ACL/Route/Audit/AD are explicitly out of scope until their
  phases.
- **Migrations & seed are generate/create-only in Phase 2.** The operator runs
  `npm run db:migrate` and `npm run db:seed` after review.
- **Sessions store only `SHA-256(token)`.** The raw token lives only in the
  `netops_session` HttpOnly cookie; it never enters the database or logs.
- **A session is created only after MFA succeeds.** A valid password alone yields
  a short-lived pre-auth MFA challenge (HttpOnly cookie), not a full session.
- **Frontend route middleware is UX only.** Real authorization is server-side via
  `requireAuthenticatedUser(event)`.
- **No new npm dependencies** are added without an explicit need; QR rendering for
  MFA setup is deferred and reported rather than pulling a package automatically.
