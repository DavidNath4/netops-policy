# AUTH audit logging — every authentication activity recorded to audit_logs

This change wires the auth endpoints into the existing `audit_logs` system of record so that every authentication outcome — login success, login failure, and logout — leaves exactly one audit row, for all user types (LOCAL + AD) and all roles (including `role_id = null`). No auth endpoint wrote an audit row before; the audit module/action enums already existed. The approach calls the existing `record(db, input)` service directly from each handler, assembles the actor/request snapshot via `buildAuditContext`, appends a new `'LOGOUT'` action value to the audit enum, and surfaces LOGOUT in the Log Trail filter. Every write is best-effort: wrapped so a failed audit insert can never change the HTTP status, body, or generic message of the auth response. The `audit_action` enum migration is intentionally not generated here (the user runs `db:generate`/`db:migrate`).

Watch for: a Postgres `ALTER TYPE ... ADD VALUE 'LOGOUT'` migration still has to be generated and applied by the user before these writes succeed at runtime (confirmed — not yet generated; by design). The diff on disk also bundles an unrelated parallel task (ACL/ROUTE two-table + exec-log work), which is out of this task's scope and left untouched by the AUTH changeset.

**Verdict**: APPROVED

## High-level view

Login failures are covered by a single module-local helper `recordLoginFailure(event, db, { identifier, user?, provider?, reason })` invoked immediately before each `throw`. All five non-success exit paths are wired: invalid body, front-of-flow disabled gate, no-provider, and the three catch branches (invalid credentials, account disabled, directory unreachable). The re-thrown unknown error path records nothing, which is correct — it is an unexpected internal fault, not an authentication outcome. `db` was hoisted above the body-parse check so the invalid-body branch can audit.

Login success is recorded at the two real session-creation points (`mfa/verify.post.ts` and `mfa/setup/verify.post.ts`), right after `createSession`, each writing one `AUTH/LOGIN/SUCCESS` row via `buildAuditContext`. Logout resolves the actor with `validateSession` BEFORE `revokeSession`, records one `AUTH/LOGOUT/SUCCESS` when a session exists, and skips the write (still returning ok, no throw) when there is none.

No password or secret ever enters an audit input. Failure payloads carry only `{ identifier, provider?, reason }` with a short machine `reason` code; success carries `{ provider }`; logout carries `null`. The actor context is limited to id/username/role snapshot + source IP + user agent. `redactPayload` inside `record()` is defense-in-depth on top of that.

The enum change appends `'LOGOUT'` at the end of `auditActionEnum` and mirrors it in the Zod `AuditActionSchema`; the Log Trail `actionOptions` gains a LOGOUT entry while keeping the `ALL` sentinel. No hand-written AUTH migration was added.

<details>
<summary>Issues (0 blocking, 2 informational)</summary>

1. **Enum migration not yet generated** (informational, by design) — the `ALTER TYPE "audit_action" ADD VALUE 'LOGOUT'` migration must be produced by the user via `db:generate`/`db:migrate` before these writes succeed at runtime. The task explicitly defers CLI to the user.
2. **Unrelated work bundled in the working tree** (informational, out of scope) — the on-disk diff also contains the ACL/ROUTE two-table + exec-log task (new `acl-logs`/`route-logs` schema, services, repos, endpoints, migration `0007_easy_morph.sql`, administration/users edits). None of it is part of the AUTH changeset and the AUTH task did not touch `user.service.ts` or administration.

</details>

<details>
<summary>Details</summary>

## Login failure coverage — one FAILED row per non-success path

`recordLoginFailure` is a module-local helper (correctly not a shared util — it is specific to this handler) called immediately before each existing `throw`. Tracing every non-success return path in `login.post.ts`:

- Invalid body (`!parsed.success`) → `{ identifier: null, reason: 'INVALID_BODY' }`, then `throw apiError(401, 'INVALID_CREDENTIALS', ...)`.
- Front-of-flow disabled gate (`existing && !existing.isActive`) → `{ identifier, user: existing, reason: 'ACCOUNT_DISABLED' }`, then `throw apiError(403, 'ACCOUNT_DISABLED', ...)`.
- No provider (`!provider`) → `{ identifier, reason: 'NO_PROVIDER' }`, then `throw apiError(401, ...)`.
- catch — `AuthError | AdCredentialsError` → `{ identifier, user: existing ?? undefined, provider, reason: 'INVALID_CREDENTIALS' }`.
- catch — `AccountDisabledError | AdAccountDisabledError` → `{ identifier, user: existing ?? undefined, provider, reason: 'ACCOUNT_DISABLED' }`.
- catch — `DirectoryUnreachableError` → `{ identifier, provider, reason: 'AD_UNREACHABLE' }`.

Each is a single call, so exactly one FAILED row per path. The final `throw err` for an unknown error records nothing — the correct choice, since it is an internal fault rather than an auth-attempt outcome, and auditing it would conflate the two. `db = useDatabase()` was hoisted above the parse check so the invalid-body branch has a `db` to write with; the later duplicate `const db` was removed. The MFA_REQUIRED success-of-first-factor path writes nothing, which is right — the login is not yet complete there; the audit SUCCESS lands at MFA verify.

## Login success and logout — one row each, actor resolved correctly

Both MFA handlers write `AUTH/LOGIN/SUCCESS` directly after `createSession(db, event, user.userId)` and `updateLastLogin`, using `...(await buildAuditContext(db, event, user))` and `requestPayload: { provider: user.authProvider }`. `user` here is a `UserRow` from `findById`, so `authProvider` (`'LOCAL' | 'AD'`) is present and non-secret.

`logout.post.ts` resolves `const user = await validateSession(db, event)` BEFORE `revokeSession`, so the LOGOUT row carries the username/role snapshot of the session being torn down. When `validateSession` returns `null` (no cookie, unknown/expired/inactive session) it never throws, so logout skips the audit and still returns `ok({ loggedOut: true })` — idempotent as required.

## No secret reaches the audit input

Failure payloads are `{ identifier, provider?, reason }`; `provider` is included only on the branches where it is resolved, and `reason` is a fixed machine code enum. Success is `{ provider }`; logout is `null`. The `password` local in `login.post.ts` is never referenced by the helper. The actor context (`buildAuditContext`) exposes only userId, username/email snapshot, role code, truncated source IP, and truncated user agent — no bind password, AD/user password, device exec credential, TOTP secret, or session token. `record()` additionally runs every payload through `redactPayload` before insert, so even an accidental secret would be masked. Nothing in these call sites logs a secret in the swallow blocks either (the catch bodies are empty).

## Audit-write isolation from the HTTP response

Every `record()` call sits inside a `try/catch` whose catch body is empty (comment-only). A failed insert therefore cannot change status codes (401/403/503 preserved verbatim), cannot alter the generic messages, and cannot leak SQL/stack/secret to the client. The failure paths were not made more distinguishable — the audit write happens before the unchanged `throw`, and its success or failure is invisible to the response.

## Enum, schema, and Log Trail filter

`auditActionEnum` becomes `['LOGIN','SHOW','ADD','DELETE','UPDATE','LOGOUT']` — `'LOGOUT'` appended at the END, not reordered, so the generated migration is a safe additive `ALTER TYPE ... ADD VALUE`. `AuditActionSchema` z.enum mirrors the same ordering with `'LOGOUT'` appended. `app/pages/logs/index.vue` `actionOptions` has a single `{ label: 'LOGOUT', value: 'LOGOUT' }` after `UPDATE`, with the `{ label: 'All', value: ALL }` sentinel untouched. Because `RecordAuditInput.action` derives from the Drizzle enum, appending the value widened the service type with no further edits. No AUTH migration SQL was hand-written; `database/migrations/0007_easy_morph.sql` present in the tree is the ACL/ROUTE exec-log migration (it creates `acl_logs`/`route_logs`, not an `audit_action` ADD VALUE) and belongs to the parallel task.

## Scope

The AUTH changeset is confined to the auth endpoints (`login.post.ts`, `logout.post.ts`, `mfa/verify.post.ts`, `mfa/setup/verify.post.ts`), the audit enum (`database/schema/audit-logs.ts`), the client enum (`shared/schemas/audit.schema.ts`), and the single Log Trail filter option. No change to `user.service.ts` or administration auditing (USER-module auditing is out of scope). Handlers stay thin: each new write is a few lines delegating to the existing `record` service plus the shared `buildAuditContext`. The other modified/untracked files in the working tree (specs, `acl.service.ts`, `route.service.ts`, `administration/index.vue`, `users/*.post.ts`, `audit.repository.ts`, new `*-logs` schema/service/repo/endpoints, migration 0007) are a separate parallel task and are not attributable to this AUTH change.

</details>

<details>
<summary>File map (AUTH changeset)</summary>

- `server/api/auth/login.post.ts` — hoisted `db`; added `recordLoginFailure` helper; one FAILED audit per non-success path.
- `server/api/auth/mfa/verify.post.ts` — one `AUTH/LOGIN/SUCCESS` row after `createSession`.
- `server/api/auth/mfa/setup/verify.post.ts` — one `AUTH/LOGIN/SUCCESS` row after `createSession`.
- `server/api/auth/logout.post.ts` — resolve actor via `validateSession` before `revokeSession`; one `AUTH/LOGOUT/SUCCESS` row when a session exists, else skip.
- `database/schema/audit-logs.ts` — append `'LOGOUT'` to `auditActionEnum`.
- `shared/schemas/audit.schema.ts` — append `'LOGOUT'` to `AuditActionSchema`.
- `app/pages/logs/index.vue` — add LOGOUT to `actionOptions`, keep `ALL` sentinel.

Full diff: `git diff main -- server/api/auth database/schema/audit-logs.ts shared/schemas/audit.schema.ts app/pages/logs/index.vue`

</details>
