# Implementation Plan — Log Trail + Auth/User/n8n Audit Overhaul

Scope: six work items in the NetOps Policy Manager repo. HEAVY, in-place.
Stack: Nuxt 4 (Vue 3 `<script setup lang="ts">` + Nitro), Drizzle ORM, PostgreSQL,
Zod, Tailwind v4 + Nuxt UI, Vitest. Node 24, TS strict.

## Hard constraints (apply to EVERY item)

- **AGENTS MUST NOT RUN ANY CLI COMMAND.** No `npm`, `drizzle-kit`, `git`, `node`,
  no shell at all. The USER runs every command. This task requires a DB migration
  (a new enum value). Do NOT hand-write migration SQL — the user runs `db:generate`.
  The implementation ENDS by stopping and printing the exact ordered USER commands
  (see "USER COMMANDS" at the bottom). Never execute them.
- **Layering:** API handler (thin) → Zod validate → auth (session middleware) →
  authorization (`requirePermission`) → service (logic/transactions) → repository
  (Drizzle only) → PostgreSQL. Handlers hold no business logic.
- **Zod is the source of truth for shapes** (`shared/schemas/`), derive types with
  `z.infer`. Never return raw DB rows to the client.
- **Audit writes are best-effort** (`try { … } catch { /* swallow */ }`) and must
  NEVER change HTTP status/body or the generic auth messages.
- **Never persist a password/secret.** Everything written to audit JSONB goes
  through `redactPayload` (already applied inside `audit.service.record`); the n8n
  request body (which contains `user`/`pass`) MUST be redacted before storage.
- **Keep docs in sync** (AGENTS.md rule): after the behavioral changes, update the
  specs noted in Item 7.
- Verification here means **re-reading the edited files and confirming imports,
  types, enum values, and component/prop names line up** — NOT running commands and
  NOT grep-only checks. The only commands in this task are the USER commands at the
  end.

## Key facts discovered during exploration (ground truth for the coder)

- `auditActionEnum` (database/schema/audit-logs.ts) is currently
  `['LOGIN', 'SHOW', 'ADD', 'DELETE', 'UPDATE', 'LOGOUT']`. `LOGOUT` was already
  appended by a prior migration — append `MFA_VERIFY` at the END for a safe
  `ALTER TYPE … ADD VALUE` generation.
- `AuditActionSchema` (shared/schemas/audit.schema.ts) is a `z.enum` mirroring the
  DB enum: `['LOGIN', 'SHOW', 'ADD', 'DELETE', 'UPDATE', 'LOGOUT']`. The audit
  query/response schemas and `AuditListFilter`/`listAudit` derive their `action`
  type from this schema (`AuditRow['action']`), so adding `MFA_VERIFY` here flows
  through the whole filter/response chain with no other type edits.
- `record(db, input)` (server/services/audit.service.ts) redacts all four JSONB
  payloads before insert. `recordWithDetail` wraps a master row + acl_logs/route_logs
  detail in one transaction (used by ACL/ROUTE).
- `buildAuditContext(db, event, user: UserRow)` (server/utils/audit-context.ts)
  snapshots `userId`, `username` (username ?? email), `userRole` (role code),
  `sourceIp`, `userAgent`. It takes a `UserRow` (not a response shape).
- login.post.ts: first factor. On success it issues an MFA challenge and returns
  `MFA_SETUP_REQUIRED` or `MFA_REQUIRED` WITHOUT creating a session. `user` here is
  the `UserResponse` from `verifyLocalCredentials`/`verifyAdCredentials`; `existing`
  is the `UserRow | undefined` from `findByEmailOrUsername`. It already records all
  LOGIN/FAILED branches via `recordLoginFailure`.
- mfa/verify.post.ts and mfa/setup/verify.post.ts: today BOTH record
  `AUTH/LOGIN/SUCCESS` after session creation. `findUserById` returns a `UserRow`,
  and `challenge.userId` is available. mfa/verify.post.ts imports
  `findById as findUserById`; mfa/setup/verify.post.ts imports the same.
- logout.post.ts already records `AUTH/LOGOUT/SUCCESS` — leave as is.
- role.patch.ts / status.patch.ts: `requirePermission(event, …)` RETURNS the acting
  admin `UserRow`. The services (`changeUserRole`, `setUserStatus`) call
  `userRepo.findById` then `findWithRoleById`; `UserWithRole` has
  `roleCode: string | null`, `roleName`, `isActive`, etc. Response shape is
  `AdminUserResponse` (has `roleCode`, `isActive`, no secrets).
- n8n-client.ts `callN8n` returns a normalized `N8nResult` and does NOT currently
  surface the raw request body or raw response body. `redact.ts` `CREDENTIAL_KEYS`
  already masks `execUsername`, `execPassword`, `password`, `pass`, `user`,
  `apiKey`, `apiToken` → confirmed sufficient for the n8n body `{ user, pass, … }`.
- acl.service.ts / route.service.ts build the n8n `body` inline and pass it to
  `callN8n`; the client-facing `OperationResult` (shared/schemas/n8n.schema.ts) is
  built by `toOperationResult` and MUST stay unchanged.
- logs/index.vue: server-side pagination, submit-driven search, immediate select/
  date filters, detail modal with ACL/ROUTE Execution Inspection. `ALL` is the
  "All" sentinel (USelect forbids empty-string values).
- Double-LOGIN root cause (Item 3): mfa/verify.vue has BOTH
  `@complete="onVerify"` on `<MfaCodeInput>` AND `@submit.prevent="onVerify()"` on
  the form; the `submitting` guard is set asynchronously, so two near-simultaneous
  verify requests can fire (~100ms apart). Today LOGIN/SUCCESS is written only in
  the verify endpoints, so two verify calls = two LOGIN/SUCCESS rows for one user
  action. mfa/setup.vue has the same `@complete` + `@submit` double path.

---

## WORK ITEM 1 — New enum value `MFA_VERIFY`

- [ ] 1. Append `'MFA_VERIFY'` to the END of `auditActionEnum` in the schema, and
      mirror it in the Zod enum so the whole filter/response chain accepts it.
      - database/schema/audit-logs.ts: change
        `pgEnum('audit_action', ['LOGIN', 'SHOW', 'ADD', 'DELETE', 'UPDATE', 'LOGOUT'])`
        → `[... 'LOGOUT', 'MFA_VERIFY']` (append at end — required for a safe
        `ALTER TYPE ADD VALUE` migration; do NOT reorder existing values).
      - shared/schemas/audit.schema.ts: change `AuditActionSchema = z.enum([...])`
        → add `'MFA_VERIFY'` at the end of the array.
      - Do NOT hand-write migration SQL.
      Files: database/schema/audit-logs.ts, shared/schemas/audit.schema.ts
      Verify: re-read both files; confirm the DB enum and the Zod enum both end with
      `'MFA_VERIFY'`. Confirm (by reading) that `AuditQuerySchema`,
      `AuditResponseSchema` (same file) and `AuditListFilter`/`listAudit`
      (server/repositories/audit.repository.ts, type `AuditRow['action']`) need NO
      edits — they derive from these enums and compile with the new value.

---

## WORK ITEM 2 — AUTH logging flow redesign

Target end state per full login: TWO rows — `AUTH/LOGIN/SUCCESS` (first factor,
written in login.post.ts) + `AUTH/MFA_VERIFY/SUCCESS` (second factor, written in
the MFA verify endpoints). MFA failure writes TWO rows:
`AUTH/MFA_VERIFY/FAILED` + `AUTH/LOGIN/FAILED`. First-factor failure writes
`AUTH/LOGIN/FAILED` only (unchanged). Depends on Item 1 only for `MFA_VERIFY`.

- [ ] 2. Add the first-factor `AUTH/LOGIN/SUCCESS` record in login.post.ts, written
      AFTER credentials verify and BEFORE issuing the MFA challenge, for BOTH the
      `MFA_SETUP_REQUIRED` and `MFA_REQUIRED` branches (both are a successful first
      factor). Add a small best-effort helper (mirror `recordLoginFailure`), e.g.
      `recordLoginSuccess(event, db, actor: UserRow)`:
      - Resolve the actor `UserRow` for the context. `buildAuditContext` needs a
        `UserRow`; `verify*Credentials` returns a `UserResponse`. Prefer the
        `existing` row when present; otherwise re-fetch with
        `findByEmailOrUsername(db, user.email)` (or `findById(db, user.userId)` —
        add the import) so AD users logged in by `sAMAccountName` still resolve.
        If no row resolves, fall back to the manual context block used in
        `recordLoginFailure` (userId null, username = identifier).
      - Write `module: 'AUTH', action: 'LOGIN', status: 'SUCCESS',
        correlationId: randomUUID(), requestPayload: { provider }, …context`.
      - Call it just before BOTH `issueMfaChallenge(...)` calls (or once right after
        `mfa` is resolved, before the branch). Wrap in try/catch and swallow.
      Files: server/api/auth/login.post.ts
      Verify: re-read login.post.ts; confirm the success record runs on both
      challenge branches, the actor resolves to a `UserRow`, no password is in the
      payload, and the try/catch swallows (response unchanged on audit failure).

- [ ] 3. In mfa/verify.post.ts, REPLACE the existing `AUTH/LOGIN/SUCCESS` record
      with `AUTH/MFA_VERIFY/SUCCESS`, and ADD the MFA-failure records.
      - Success path (after `createSession` + `updateLastLogin`): keep the
        best-effort block but set `action: 'MFA_VERIFY'`, `status: 'SUCCESS'`
        (module stays `'AUTH'`, `requestPayload: { provider: user.authProvider }`,
        context via `buildAuditContext(db, event, user)`).
      - Failure path: at EACH failure branch where the actor is knowable from
        `challenge.userId`, write TWO best-effort rows — `AUTH/MFA_VERIFY/FAILED`
        and `AUTH/LOGIN/FAILED` — then throw the existing `apiError` unchanged.
        Resolve the actor via `findUserById(db, challenge.userId)` (already
        imported); if the user is unresolvable, write with userId null and whatever
        identifier is known (reuse the manual context shape from
        login.post.ts `recordLoginFailure`). Cover: invalid/expired code
        (`!valid`), and the post-verify user missing/inactive branch. The
        "challenge invalid/expired" early-return (`!challenge`) has NO known actor;
        record `AUTH/MFA_VERIFY/FAILED` + `AUTH/LOGIN/FAILED` with userId null and a
        `{ reason: 'MFA_CHALLENGE_INVALID' }` payload (best-effort, no secret).
        Keep a shared local best-effort helper to avoid repeating the two-row write.
      Files: server/api/auth/mfa/verify.post.ts
      Verify: re-read; confirm success writes exactly `MFA_VERIFY/SUCCESS` (NOT
      `LOGIN/SUCCESS`), each failure path writes `MFA_VERIFY/FAILED` + `LOGIN/FAILED`,
      every write is best-effort, HTTP responses (`apiError` codes/messages) are
      unchanged, and no code/secret is persisted.

- [ ] 4. Apply the SAME change pattern as Item 3 to mfa/setup/verify.post.ts
      (enrollment-then-verify path): replace `AUTH/LOGIN/SUCCESS` with
      `AUTH/MFA_VERIFY/SUCCESS` on success, and add `AUTH/MFA_VERIFY/FAILED` +
      `AUTH/LOGIN/FAILED` on the invalid-code and missing/inactive-user branches
      (actor from `challenge.userId` via `findUserById`, same fallbacks).
      Files: server/api/auth/mfa/setup/verify.post.ts
      Verify: re-read; same checks as Item 3; the two files follow one consistent
      pattern.

---

## WORK ITEM 3 — Double `AUTH/LOGIN/SUCCESS` fix (frontend double-submit)

Root cause (confirmed from code, re-confirm during implementation): the MFA pages
fire the verify request twice because `<MfaCodeInput>` emits `@complete` (auto-submit
on the 6th digit) while the form also handles `@submit.prevent`, and the
`submitting`/`loading` guard is set asynchronously after the request starts.

- [ ] 5. Guard the MFA verify submit against double-fire with a synchronous in-flight
      ref, and ensure the form submit and the `@complete` auto-submit cannot both
      launch a request.
      - app/pages/mfa/verify.vue: in `onVerify`, return immediately if
        `submitting.value` is already true (synchronous guard at the top, before any
        `await`). The template `<UButton>` is already `:loading="submitting"`;
        confirm it is effectively disabled while loading (add `:disabled="submitting"`
        if needed) and that `MfaCodeInput` is `:disabled="… || submitting"` (already
        is). Keep `@complete` for UX but rely on the in-flight guard to dedupe.
      - app/pages/mfa/setup.vue: apply the identical synchronous guard in `onVerify`
        (`if (submitting.value) return` before any await); `MfaCodeInput` is already
        `:disabled="expired || submitting"`.
      - Do NOT add a server-side idempotency store (not warranted).
      Files: app/pages/mfa/verify.vue, app/pages/mfa/setup.vue
      Verify: re-read both files; confirm `onVerify` has a top-of-function
      synchronous `if (submitting.value) return` guard set true BEFORE the first
      `await` and reset in `finally`, so a near-simultaneous `@complete` + form
      submit yields exactly one request. Note in the code comment that after Item 2,
      LOGIN/SUCCESS and MFA_VERIFY/SUCCESS are two DIFFERENT actions and are expected;
      the bug is two rows of the SAME action. (If the running system still shows
      duplicate same-action rows after this fix, flag as "needs verification during
      implementation" and inspect the login form path in app/pages/login.vue, which
      already guards with `loading` but should be re-confirmed.)

---

## WORK ITEM 4 — USER-module audit (role change + status change)

Reuse action `UPDATE` (no new enum); distinguish via a `kind` field in the payload.
Actor is the authenticated admin; the TARGET user goes in the payload, never as the
actor. Scope: role change and status change ONLY (not create/edit/reset-password).

- [ ] 6. Thread the acting admin + request context from the endpoints into the user
      service and record a best-effort `USER/UPDATE` audit row per mutation.
      - server/api/users/[id]/role.patch.ts: `requirePermission(...)` already returns
        the acting admin `UserRow` — capture it (`const actor = await
        requirePermission(event, PERMISSIONS.ADMINISTRATION_MANAGE)`). Pass `event`
        and `actor` into the service so it can build the audit context. On
        `UserNotFoundError`/`RoleNotFoundError`, still record a `FAILED` row
        (either inside the service before throwing, or in the catch — keep it
        best-effort and do not change the HTTP responses).
      - server/api/users/[id]/status.patch.ts: same — capture `actor`, pass
        `event` + `actor` to `setUserStatus`.
      - server/services/user.service.ts: extend `changeUserRole` and `setUserStatus`
        signatures to accept `(db, event, actor, userId, input)` (mirror how ACL/
        ROUTE services take an `AuditContext`; here build it inside the service via
        `buildAuditContext(db, event, actor)` to keep the handler thin, OR build the
        context in the handler and pass `AuditContext` — pick building in the
        service to match the two endpoints uniformly). Within each:
        - Resolve `fromRole`/target username from the pre-change `findWithRoleById`
          (role change) or the existing row (status change) BEFORE mutating.
        - After the successful repo write, `record(db, { module: 'USER',
          action: 'UPDATE', status: 'SUCCESS', correlationId: randomUUID(),
          requestPayload, …buildAuditContext(db, event, actor) })` — best-effort
          try/catch.
        - Role change payload: `{ kind: 'ROLE_CHANGE', targetUserId, targetUsername?,
          fromRole?, toRole }` (toRole = `input.roleCode`).
        - Status change payload: `{ kind: 'STATUS_CHANGE', targetUserId,
          targetUsername?, isActive }`.
        - On the not-found/role-not-found error paths, optionally record a
          `status: 'FAILED'` row with the same payload shape before re-throwing;
          keep best-effort. Never include a password.
        - Import `record` from `./audit.service`, `buildAuditContext` from
          `../utils/audit-context`, and `randomUUID` from `node:crypto` (mirror the
          ACL/ROUTE services).
      Files: server/api/users/[id]/role.patch.ts,
      server/api/users/[id]/status.patch.ts, server/services/user.service.ts
      Verify: re-read all three; confirm the acting admin is the audit actor and the
      target user is only in the payload; `UPDATE` action + `kind` discriminator;
      no password in payload; audit writes best-effort; the endpoints still return
      the same `AdminUserResponse`/error envelopes; layering preserved (handler
      resolves actor + calls service; service does the audit).

---

## WORK ITEM 5 — Capture raw n8n request & response in ACL/ROUTE audit

Record the ACTUAL (redacted) n8n request body and raw response body inside the
EXISTING ACL/ROUTE audit rows — no separate N8N module. The browser `OperationResult`
contract must NOT change.

- [ ] 7. Surface the raw request/response from `callN8n` without changing the client
      contract, then store them (redacted) in the ACL/ROUTE audit payloads.
      - server/network/n8n-client.ts: have `callN8n` return the raw request body and
        the raw parsed response body alongside the normalized result. Minimal shape:
        return `N8nResult & { raw?: { request: unknown, response: unknown } }` (add
        a `raw` field; keep all existing `N8nResult` fields intact so every current
        caller still compiles). Populate `raw.request = options.body` and
        `raw.response = body` (the parsed JSON, or null). On the catch/timeout path,
        set `raw.response = null` (and still include `raw.request`). Do NOT change
        `normalize`'s return; wrap/merge at the end of `callN8n`.
        - Keep the function's "never throws" guarantee.
        - Note the type: either widen the local return type inline, or add a small
          `N8nCallResult` type in the client file (NOT in the shared schema, to keep
          the client contract untouched). Prefer a local type in n8n-client.ts.
      - server/services/acl.service.ts (aclShow + aclExecute) and
        server/services/route.service.ts (routeShow + routeExecute): read
        `result.raw` and put it into the audit payloads via the already-redacting
        `record`/`recordWithDetail` path. Add to each master row:
        `executionPayload`/`responsePayload` already exist — ADD the redacted raw
        request/response. Recommended placement:
        - Put the redacted raw request into `requestPayload` as an extra field, e.g.
          merge `{ …existingRequestPayload, n8nRequest: result.raw?.request ?? null }`
          — BUT the raw request contains `user`/`pass`; rely on `record()`'s
          `redactPayload` (it masks `user`/`pass`) AND, for defense-in-depth in the
          acl_logs/route_logs detail writer, wrap with `redactPayload(...)` as those
          writers already do.
        - Put the raw response into `responsePayload` as `{ …existing, n8nResponse:
          result.raw?.response ?? null }`.
        - For the acl_logs/route_logs detail rows, add the raw request/response into
          `executionMeta`/`responseSummary` (already wrapped in `redactPayload`), or
          keep detail as-is and only enrich the master row — pick enriching the
          master `request_payload`/`response_payload` for both ACL and ROUTE so the
          Log Trail detail modal shows them.
        - `toOperationResult` and the returned `OperationResult` MUST stay unchanged
          (do not add `raw` to the client result).
      Files: server/network/n8n-client.ts, server/services/acl.service.ts,
      server/services/route.service.ts
      Verify: re-read all three; confirm `callN8n` still returns a value assignable to
      every existing use (all current `N8nResult` fields present), the raw request is
      only ever persisted through `redactPayload` (confirm `CREDENTIAL_KEYS` in
      redact.ts masks `user`/`pass`/`execUsername`/`execPassword`/`apiKey`), the raw
      response is stored redacted, and the client `OperationResult` shape is
      byte-for-byte unchanged. Confirm aclShow/routeShow (which have no exec creds in
      the body) also capture their `{ user, pass, … }` request redacted.

---

## WORK ITEM 6 — Log Trail UI (app/pages/logs/index.vue)

Keep ALL script logic (server-side pagination, submit search, detail modal, ACL/ROUTE
Execution Inspection) intact. UI/ copy in ENGLISH. Follow .kiro/steering/ui-conventions.md.
Depends on Item 1 (`MFA_VERIFY` is a valid filter value through `AuditActionSchema`).

- [ ] 8. Rework the option arrays and add the Module→Action dependency.
      - Remove `N8N` from `moduleOptions` (n8n folded into ACL/ROUTE).
      - Replace the flat `actionOptions` with a dependent, Module-keyed computed
        `actionOptions` using this EXACT mapping (each list begins with
        `{ label: 'All', value: ALL }`):
        - Module = `ALL` → All + LOGIN, LOGOUT, MFA_VERIFY, SHOW, ADD, DELETE, UPDATE
        - `AUTH` → All, LOGIN, LOGOUT, MFA_VERIFY
        - `ACL` → All, SHOW, ADD, DELETE
        - `ROUTE` → All, SHOW, ADD, DELETE
        - `USER` → All, UPDATE
      - Add a `watch(() => filters.module, …)`: when Module changes and the selected
        `filters.action` is no longer valid for the new Module's list, reset
        `filters.action = ALL`. Keep the existing page-1 reset + reload behavior
        (the existing filter watcher already covers module/action changes; ensure the
        action-reset runs before/with the reload so the request is consistent).
      Files: app/pages/logs/index.vue
      Verify: re-read; confirm the mapping matches exactly, N8N is gone from the
      Module dropdown, Action resets to `ALL` on an invalid Module switch, and
      `MFA_VERIFY` is selectable (valid against the updated `AuditActionSchema`).

- [ ] 9. Compact filter layout: Search on its own top row (with Search + Reset
      buttons, as today); row 2 = Module, Action, Status, From, To in ONE responsive
      row (wrap on small screens, single row on desktop).
      - Keep the search block as-is (it already spans full width with Search/Reset).
      - Put Module/Action/Status/From/To in a flex/grid row that collapses on small
        screens and sits on one line at `lg:` (e.g. a grid
        `grid-cols-1 sm:grid-cols-2 lg:grid-cols-5` or a wrapping flex). Keep each
        field wrapped in the shared `FormField`; do NOT restyle `FormField`.
      - Keep the existing USelect styling
        (`color="neutral" variant="outline" :ui="{ base: 'bg-panel text-ink ring-line' }"`)
        and the native date inputs' token classes. Keep the `ALL` sentinel.
      Files: app/pages/logs/index.vue
      Verify: re-read; confirm the four fields (Action/Status/From/To) plus Module
      sit on a single desktop row, use token-backed classes only (no hex), and
      `FormField` is reused unchanged.

- [ ] 10. Add the Source IP master column.
      - Master columns become: Time, User, Source IP, Module, Action, Status.
        Insert a `<th>Source IP</th>` (after User) and a matching `<td>` rendering
        `row.sourceIp ?? '—'` in a small monospace-ish cell (e.g. `font-mono text-xs`).
      - Add a matching skeleton `<td>` cell so the loading row column count stays
        aligned. Keep User Agent / Correlation / Change Ticket OUT of the master
        (they remain in the detail modal). Increase the table `min-w-[…]` as needed
        for the extra column.
      Files: app/pages/logs/index.vue
      Verify: re-read; confirm header, data row, and skeleton row all have the same
      column count (6), Source IP shows `—` when null, and the detail modal still
      shows the hidden fields.

- [ ] 11. Make the table body scroll inside a fixed-height container with a sticky
      header, and keep pagination directly beneath the scroll container.
      - Wrap the `<table>` in a scroll container: keep `overflow-x-auto` for narrow
        screens and add a vertical scroll wrapper with a viewport-relative max height
        (e.g. `max-h-[60vh] overflow-y-auto`) consistent with the app shell so the
        page doesn't grow with rows.
      - Make `<thead>` sticky: `class="sticky top-0 z-10"` on the thead (and keep its
        `bg-surface` so rows don't show through). Ensure header cells keep a solid
        background while scrolling.
      - Keep the `<Pagination>` component directly below the scroll container (outside
        it) so it stays visible; keep the `v-if="total > ITEMS_PER_PAGE"` guard.
      Files: app/pages/logs/index.vue
      Verify: re-read; confirm the scroll container has a max-height + overflow-y-auto,
      the thead is `sticky top-0` with a solid background, `overflow-x-auto` is
      preserved, and pagination sits beneath the scroll area (not inside it).

---

## WORK ITEM 7 — Keep specs in sync (AGENTS.md rule)

- [ ] 12. Update the specs that document the audit action enum and auth logging flow
      to reflect `MFA_VERIFY` and the new two-row login/MFA logging.
      - .kiro/specs/netops-policy-manager/design.md: the `auditActionEnum` line and
        the two inline comments (`// LOGIN | SHOW | ADD | DELETE | UPDATE …`) and the
        `AuditQuerySchema`/`AuditResponseSchema` enum arrays — add `MFA_VERIFY`; note
        the dev DB order now ends `… UPDATE, LOGOUT, MFA_VERIFY`. Add a short note on
        the new flow: LOGIN/SUCCESS (first factor) + MFA_VERIFY/SUCCESS (second
        factor); MFA failure = MFA_VERIFY/FAILED + LOGIN/FAILED.
      - .kiro/specs/netops-policy-manager/requirements.md: the "Auth activity audited"
        bullet and Acceptance Criterion 1 action list — add `MFA_VERIFY` and the
        two-row success/failure semantics; note USER role/status changes record
        `UPDATE` with a `kind` discriminator.
      - .kiro/specs/n8n-integration/tasks.md: note that `MFA_VERIFY` was appended to
        the enum and that ACL/ROUTE audit now captures the redacted raw n8n
        request/response in the master row payloads.
      Files: .kiro/specs/netops-policy-manager/design.md,
      .kiro/specs/netops-policy-manager/requirements.md,
      .kiro/specs/n8n-integration/tasks.md
      Verify: re-read the edited sections; confirm the enum lists, the auth-flow
      description, and the n8n-capture note match the implemented behavior.

---

## Final cross-check (coder, before stopping)

- [ ] 13. Re-read the full edited set and confirm the type chain compiles logically:
      `MFA_VERIFY` is in both the DB enum and `AuditActionSchema`; `AuditQuerySchema`
      /`AuditResponseSchema`/`AuditListFilter`/`listAudit` accept it unchanged; the
      new auth records use valid module/action pairs; USER uses `UPDATE`; ACL/ROUTE
      `OperationResult` is unchanged; the Log Trail UI references only valid enum
      values and token classes. No CLI was run. No secret/password is persisted in
      any payload.

---

## USER COMMANDS (print these at the very end — the USER runs them, agents do NOT)

Run in this exact order from the project root after all code edits are complete:

```
npm run db:generate
npm run db:migrate
npm run typecheck
```

- `db:generate` creates the migration for the appended `audit_action` enum value
  `MFA_VERIFY` (an `ALTER TYPE … ADD VALUE`). Review the generated SQL before applying.
- `db:migrate` applies it to the dev database (schema, migrations, and dev DB stay
  consistent per AGENTS.md).
- `npm run typecheck` confirms the TypeScript/Zod/Vue changes compile.
- Optional: `npm run lint` and `npm run test` (Vitest) if you want the full gate.
