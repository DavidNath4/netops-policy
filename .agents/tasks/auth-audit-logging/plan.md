# Implementation Plan — AUTH audit logging

Goal: record every authentication activity (login success/failure, logout) to the
existing `audit_logs` table, for ALL user types (LOCAL + AD) and ALL roles
(including `role_id = null`). The audit module/action enums already exist, but no
auth endpoint currently writes an audit row — this fills that gap.

## Design decisions (grounded in the code read)

- **Call `record()` directly from the auth handlers.** `server/services/audit.service.ts`
  exposes `record(db, input)` which writes one row and redacts every payload via
  `redactPayload`. AUTH has no detail table (ACL/ROUTE use `recordWithDetail`), so
  `record()` is the right call. This matches how the ROUTE service already records
  audit rows.
- **One tiny helper for login failures.** `login.post.ts` has five non-success exit
  paths. To avoid duplicating the best-effort try/catch + context assembly, add a
  small module-local helper `recordLoginFailure(event, db, { identifier, user, reason })`
  inside `login.post.ts` (not a shared util — it is specific to this handler). Login
  success and logout are single call sites, so they call `record()` inline with
  `buildAuditContext`.
- **`correlationId` is `.notNull()` on `audit_logs`.** ROUTE/ACL generate it with
  `randomUUID()` (see `server/services/route.service.ts`). AUTH events are standalone
  (no n8n execution to correlate), so generate a fresh `randomUUID()` per audit write.
- **No password ever enters the audit input.** `requestPayload` for AUTH carries only
  non-secret fields: `identifier`, optional `provider`, and a short machine `reason`
  code. `redactPayload` is defense-in-depth; we still never pass password values in.
- **Appending `'LOGOUT'` to the enum needs no service type change.** `RecordAuditInput.action`
  is `AuditRow['action']`, derived from the Drizzle `auditActionEnum`; appending the
  value widens the type automatically.
- **Best-effort isolation.** Every audit write is wrapped so a DB failure never changes
  the HTTP response, status code, or generic message. Use a local `void` async pattern
  with a swallowed catch (no secret in the log line).

## Items

- [ ] 1. Append `'LOGOUT'` to `auditActionEnum` (at the END) in the DB schema.
      Change `pgEnum('audit_action', ['LOGIN', 'SHOW', 'ADD', 'DELETE', 'UPDATE'])`
      to `['LOGIN', 'SHOW', 'ADD', 'DELETE', 'UPDATE', 'LOGOUT']`. Appending at the end
      keeps the generated migration a safe `ALTER TYPE ... ADD VALUE`.
      Files: `database/schema/audit-logs.ts`
      Verify: covered by the typecheck in item 8 (and the user's `db:generate` in item 7
      must emit an `ADD VALUE 'LOGOUT'` migration).

- [ ] 2. Add `'LOGOUT'` to the client Zod enum so the Log Trail filter and response
      typing accept it. Change `AuditActionSchema = z.enum(['LOGIN', 'SHOW', 'ADD', 'DELETE', 'UPDATE'])`
      to include `'LOGOUT'` at the end.
      Files: `shared/schemas/audit.schema.ts`
      Verify: typecheck (item 8); `AuditAction` now includes `'LOGOUT'`.

- [ ] 3. Add a `LOGOUT` option to the Log Trail action filter. In the `actionOptions`
      array append `{ label: 'LOGOUT', value: 'LOGOUT' }` after the `UPDATE` entry.
      Keep the existing `ALL` sentinel pattern untouched. This is the only frontend change.
      Files: `app/pages/logs/index.vue`
      Verify: typecheck (item 8); the Action select now lists LOGOUT and it is filterable.

- [ ] 4. Record LOGIN SUCCESS at the two real session-creation points. In each handler,
      immediately AFTER `createSession(db, event, user.userId)` succeeds (and before/around
      `updateLastLogin`), write a best-effort audit row:
      `record(db, { module: 'AUTH', action: 'LOGIN', status: 'SUCCESS', correlationId: randomUUID(), requestPayload: { provider: user.authProvider }, ...(await buildAuditContext(db, event, user)) })`.
      Wrap in a try/catch that swallows errors so a write failure cannot change the
      `AUTHENTICATED` response. Import `record` from `../../../services/audit.service`
      (adjust relative depth per file), `buildAuditContext` from the matching
      `../utils/audit-context`, and `randomUUID` from `node:crypto`.
      Files: `server/api/auth/mfa/verify.post.ts`, `server/api/auth/mfa/setup/verify.post.ts`
      Verify: typecheck (item 8). After migration, a successful MFA verify / enrollment
      leaves exactly one `AUTH / LOGIN / SUCCESS` row with the actor's username+role snapshot.

- [ ] 5. Record LOGIN FAILED on every non-success path in `login.post.ts`. Add a
      module-local helper and call it before each throw:
      - Helper signature:
        `async function recordLoginFailure(event, db, args: { identifier: string | null, user?: UserRow, reason: 'INVALID_CREDENTIALS' | 'ACCOUNT_DISABLED' | 'AD_UNREACHABLE' | 'NO_PROVIDER' | 'INVALID_BODY' }): Promise<void>`.
        Inside: build context — if `args.user` is present use `await buildAuditContext(db, event, args.user)`;
        otherwise inline `{ userId: null, username: args.identifier, userRole: null, sourceIp: getRequestIP(event)?.slice(0,64) ?? null, userAgent: getRequestHeader(event,'user-agent')?.slice(0,512) ?? null }`
        (mirrors `audit-context.ts`). Then `await record(db, { module: 'AUTH', action: 'LOGIN', status: 'FAILED', correlationId: randomUUID(), requestPayload: { identifier: args.identifier, provider, reason: args.reason }, ...context })`.
        Wrap the whole body in try/catch that swallows errors (never throws, never logs secrets).
        `provider` in the payload is optional — include it only where known (set it from
        the resolved `provider` on the credential-failure branches; omit on INVALID_BODY/NO_PROVIDER).
      - Call sites, one audit row each, immediately before the existing throw:
        1. Invalid body (`!parsed.success`): `recordLoginFailure(event, db, { identifier: null, reason: 'INVALID_BODY' })`. Note `db`/`env` are created after this check today — move the `const db = useDatabase()` (and keep `getRequestIP`/`getRequestHeader` imports) above this block, or create a local `db` for the helper; simplest is to hoist `const db = useDatabase()` to the top of the handler before the parse check.
        2. Front-of-flow disabled gate (`existing && !existing.isActive`): `{ identifier, user: existing, reason: 'ACCOUNT_DISABLED' }`.
        3. No provider (`!provider`): `{ identifier, reason: 'NO_PROVIDER' }`.
        4. Catch block — `AuthError | AdCredentialsError`: `{ identifier, user: existing ?? undefined, reason: 'INVALID_CREDENTIALS' }`.
        5. Catch block — `AccountDisabledError | AdAccountDisabledError`: `{ identifier, user: existing ?? undefined, reason: 'ACCOUNT_DISABLED' }`.
        6. Catch block — `DirectoryUnreachableError`: `{ identifier, reason: 'AD_UNREACHABLE' }`.
      - Do NOT record on the re-thrown unknown `err` (`throw err`) — that is an
        unexpected internal error, not an auth attempt outcome. Keep all existing status
        codes (401/403/503) and generic messages exactly as they are.
      - Imports to add: `record` from `../../services/audit.service`, `buildAuditContext`
        from `../../utils/audit-context`, `getRequestHeader`/`getRequestIP` from `h3`,
        `randomUUID` from `node:crypto`, and the `UserRow` type from `../../repositories/user.repository`.
      Files: `server/api/auth/login.post.ts`
      Verify: typecheck (item 8). After migration, each failing login path produces exactly
      one `AUTH / LOGIN / FAILED` row; the `requestPayload` has no password key.

- [ ] 6. Record LOGOUT in `logout.post.ts` with the actor resolved BEFORE revoking.
      Replace the body so it: resolves `const db = useDatabase()`; `const user = await validateSession(db, event)`;
      if `user` is non-null, best-effort `record(db, { module: 'AUTH', action: 'LOGOUT', status: 'SUCCESS', correlationId: randomUUID(), requestPayload: null, ...(await buildAuditContext(db, event, user)) })`
      (try/catch swallow); THEN `await revokeSession(db, event)` and `clearMfaChallenge(event)`;
      return the existing `ok({ loggedOut: true })`. If `validateSession` returns null, skip
      the audit and still return success (idempotent) — do not throw.
      Imports to add: `validateSession` (already have `revokeSession`) from
      `../../services/session.service`, `record` from `../../services/audit.service`,
      `buildAuditContext` from `../../utils/audit-context`, `randomUUID` from `node:crypto`.
      Files: `server/api/auth/logout.post.ts`
      Verify: typecheck (item 8). After migration, logging out with a valid session writes
      one `AUTH / LOGOUT / SUCCESS` row; logging out with no session writes none and still returns ok.

- [ ] 7. USER COMMANDS — generate and apply the migration (the user runs these; do not run them).
      `npm run db:generate` then `npm run db:migrate`. `db:generate` must produce a migration
      containing `ALTER TYPE "audit_action" ADD VALUE 'LOGOUT'`. Confirm the dev DB applies it.
      Files: (generated) `database/migrations/*` — do not hand-write.
      Verify: `npm run db:migrate` completes; the `audit_action` type in the dev DB includes LOGOUT.

- [ ] 8. USER COMMAND — typecheck the whole change (the user runs this; do not run it).
      `npm run typecheck`.
      Verify: `nuxt typecheck` reports 0 errors (the AUTH enum widening, the inline context
      object shape, and all new imports resolve cleanly).

## No-password / isolation requirements (apply to every write above)

- Never pass any password value (NetOps LOCAL first factor, AD bind/user password,
  device exec credentials) into the audit input. For failures, `requestPayload` carries
  only `{ identifier, provider?, reason }`. For success, `{ provider }` or `null`. For
  logout, `null`.
- Never log TOTP secrets or session tokens.
- Every `record()` call is wrapped best-effort: a write failure must not alter the HTTP
  status, body, or generic message of the auth response, and must not leak SQL/stack/secrets.

## Verified facts (no longer assumptions)

- `user.authProvider` is a non-secret `'LOCAL' | 'AD'` discriminator present on `UserRow`
  (`database/schema/users.ts`, via `$inferSelect`) and on `UserResponse`
  (`shared/schemas/user.schema.ts`). The MFA verify handlers hold a `UserRow` from
  `findById`, so `user.authProvider` is available for the success payload.
- `audit_logs.correlationId` is `.notNull()`, so a `randomUUID()` per AUTH write is required.
- `RecordAuditInput.action` is `AuditRow['action']` (derived from `auditActionEnum`), so
  appending `'LOGOUT'` to the enum widens the service type with no further edits.

## Verification note (implementation complete — verified by re-reading; CLI not run)

Could not run `npm run typecheck` (user runs all CLI). Verified by re-reading the
edited files:

- **Enum appended**: `auditActionEnum` is now
  `['LOGIN','SHOW','ADD','DELETE','UPDATE','LOGOUT']` — `'LOGOUT'` at the END, so
  `db:generate` yields a safe `ALTER TYPE ... ADD VALUE 'LOGOUT'`.
- **Zod enum**: `AuditActionSchema` now includes `'LOGOUT'` (matches the DB enum).
- **Frontend**: `app/pages/logs/index.vue` `actionOptions` has a `LOGOUT` entry after
  `UPDATE`; the `ALL` sentinel is untouched. (Only frontend change.)
- **login.post.ts — exactly one FAILED row per non-success path**: INVALID_BODY (no
  identifier), ACCOUNT_DISABLED front gate (`existing`), NO_PROVIDER, and the three
  catch branches (INVALID_CREDENTIALS, ACCOUNT_DISABLED, AD_UNREACHABLE). The
  re-thrown unknown `err` records nothing (not an auth outcome). `db` was hoisted
  above the body parse so the INVALID_BODY branch can audit.
- **No password in any audit input**: `recordLoginFailure` payload is only
  `{ identifier, provider?, reason }`; the `password` variable is never passed in.
  Success payload is `{ provider: user.authProvider }`; logout payload is `null`.
- **Success rows**: `mfa/verify.post.ts` and `mfa/setup/verify.post.ts` each record one
  `AUTH/LOGIN/SUCCESS` right after `createSession`, via `buildAuditContext(db,event,user)`.
- **Logout**: `logout.post.ts` resolves the actor via `validateSession` BEFORE
  `revokeSession`, records `AUTH/LOGOUT/SUCCESS` only when a session exists, else skips
  and still returns `ok({ loggedOut: true })`.
- **Best-effort isolation**: every `record()` call is wrapped in `try/catch` that
  swallows errors — a write failure cannot change the HTTP status/body/message and
  leaks no detail. All existing status codes (401/403/503) and generic messages are
  unchanged.
- **Types**: `UserRow = users.$inferSelect` carries `authProvider`; `findById` returns
  `UserRow`; `Database` imported from `~~/database` (same alias audit.service uses);
  `record()`'s `action` widens automatically with the enum. User must run `typecheck`.
