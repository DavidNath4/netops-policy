# Design Review — iTop Ticket Integration

Reviewer: fresh design-review pass (no authoring context). Scope reviewed:
`.agents/tasks/itop-ticket-integration/design.md`, grounded against
`investigation.md`, `admin-investigation.md`, `.kiro/steering/ui-conventions.md`,
`AGENTS.md`, and the actual repository source. The FIXED constraints (DECISIONS
ALREADY MADE, iTOP SCHEMA FACTS, N3 "no tests / no vitest config") were treated
as given and were NOT re-litigated; this review checks only whether the design
builds on them correctly and completely.

## Verdict

This is a third-round design that has already resolved two prior review cycles
(design.md §16, §17). I independently verified the design's claims against the
live source for the files it edits. The four open decisions are concretely
resolved, every edited file path is named (§15), SELECT-only / parameterized /
timeout-bounded / no-secret-leak are enforced at a single owned layer (§5, §12),
`changeTicket` is required end-to-end (§4.1, §10.3, §12), and the spec-doc
updates are specified (§13).

I found no HIGH or MEDIUM issues. The findings below are all NITs.

---

## Findings

### 1. NIT — §7 misstates where `PERMISSIONS` is imported from

§7 says the two test handlers import "`PERMISSIONS` from wherever
`requirePermission`/`PERMISSIONS` are exported in `server/utils/auth`". That is
inaccurate: `server/utils/auth.ts` exports `requirePermission` /
`assertSameOrigin` / `requireAuthenticatedUser`, but it does NOT export
`PERMISSIONS`. Verified in `server/api/acl/show.post.ts` and
`server/api/acl/execute.post.ts`: `PERMISSIONS` is imported from the alias
`#shared/constants/rbac`, while `requirePermission`/`assertSameOrigin` come from
the relative `../../utils/auth`. An implementer following §7 literally would
look for `PERMISSIONS` in the wrong module.

CONCRETE FIX — in §7, state the two imports explicitly for the test handlers
(two levels below `server/`):

```ts
// server/api/itop/test.post.ts  &  server/api/n8n/test.post.ts
import { PERMISSIONS } from '#shared/constants/rbac'          // alias, NOT ../../utils/auth
import { assertSameOrigin, requirePermission } from '../../utils/auth'
import { apiError, ok } from '../../utils/envelope'
import { pingItop } from '../../network/itop-client'          // test.post.ts (itop)
// or: import { pingN8n } from '../../network/n8n-client'     // test.post.ts (n8n)
```

### 2. NIT — `ItopTicketModal` `v-model` vs the underlying `UModal` open-model is left implicit

§10.2 defines `ItopTicketModal` with `modelValue: boolean` +
`update:modelValue`, and §10.3 wires it as `<ItopTicketModal v-model="ticketModalOpen">`.
That is valid Vue for a custom component. But the repo's only `UModal` usage
(`app/components/DeviceCredentialsModal.vue`) drives Nuxt UI's modal with
`v-model:open="open"` (the `open` model), not a bare `v-model`. The design does
not say how `ItopTicketModal`'s `modelValue` is forwarded to the inner `UModal`,
which is exactly the wiring that bit the device-credentials modal (it needs
`:open`/`@update:open`, not `v-model`).

CONCRETE FIX — add one line to §10.2 stating the inner wiring, e.g.: "Inside
`ItopTicketModal`, bind the Nuxt UI modal with
`<UModal :open="modelValue" @update:open="emit('update:modelValue', $event)">`
(matching `DeviceCredentialsModal.vue`'s `v-model:open` mechanics), since Nuxt
UI's `UModal` uses the `open` model, not the default `modelValue`."

### 3. NIT — `pingItop` runs `run('SELECT 1', [])` through the array-expansion `run()`, but `SELECT 1` has no placeholder

§5 `pingItop` calls `await run('SELECT 1', [])`. `run()` uses the plain
`conn.query(sql, params)` form chosen (correctly) for `IN (?)` expansion. Passing
an empty params array to a parameterless query is harmless with mysql2's
`query()`, so this is not a defect — but the design should note it so an
implementer does not "helpfully" switch `pingItop` to `conn.ping()` or
`.execute()` and reintroduce the array-expansion/`timeout` concerns §5 and
Finding 2 of round two were built to avoid.

CONCRETE FIX — add a sentence to the `pingItop` snippet in §5: "`SELECT 1` has no
placeholder; pass `[]` and keep it going through `run()` so it inherits the same
`Promise.race` timeout bound — do not substitute `conn.ping()` or `.execute()`."

---

## Verified Assumptions (checked against live source)

- **`changeTicket` is `.optional()` today in both feature schemas.** Confirmed:
  `shared/schemas/acl.schema.ts` `AclFields.changeTicket: ChangeTicketSchema.optional()`
  and `shared/schemas/route.schema.ts` `RouteFields.changeTicket:
  ChangeTicketSchema.optional()`. Dropping `.optional()` (§4.1) flows into the
  Add/Delete/Preview/Execute merges as the design claims.
- **All four pages wrap `buildPayload()`'s return in an `as *Input` cast and send
  `form.changeTicket.trim() || undefined`.** Confirmed in `app/pages/acl/add.vue`
  and `app/pages/routes/add.vue` (delete pages are stated analogous). §4.1's
  removal-of-cast rationale is accurate: the cast would otherwise suppress the
  required-field tsc error (N3's only compile-time safety net).
- **The Generate buttons use `:disabled="generating || !ipsValid"` (ACL) /
  `generating || !ipValid` (route) native buttons.** Confirmed. §10.3's exact
  `|| !form.changeTicket` disable-term append (and the warning against
  `&& !!form.changeTicket`) is correct.
- **The Execute button only renders via `v-else` once `preview` is non-null.**
  Confirmed; §10.3's claim that gating Generate transitively gates Execute holds.
- **`watch(form, ...)` sets `preview/result/warningMsg` to null on any change.**
  Confirmed in both pages; §10.3's reasoning about the readonly input staying
  reactive and stale-preview invalidation is correct.
- **`FormField` supports a `required` prop (asterisk + aria).** Confirmed in
  `app/components/FormField.vue`; it renders the error slot with
  `role="alert"`. §10.3 reusing `FormField` unmodified is valid.
- **Envelope / `ErrorCode` union has no iTop code.** Confirmed in
  `server/utils/envelope.ts`; adding `'ITOP_UNREACHABLE'` (§9.1) is required and
  sufficient (`N8N_UNREACHABLE` genuinely unneeded since the test endpoints
  return `ok({ ok:false })`).
- **Config is a single Zod `EnvSchema` parsed by `loadEnv()`, no
  `runtimeConfig`.** Confirmed in `server/utils/config.ts`; the N8N block is the
  pattern §9.2 copies; both new vars optional/defaulted keeps boot resilient (R17).
- **`n8n-client.ts` pattern (AbortController + `N8N_TIMEOUT_MS` + never-throw +
  no key leak).** Confirmed; `pingN8n` (§8) faithfully mirrors
  `validateDeviceCredentials`, and the host-root GET avoids the `/webhook` path /
  POST-triggers-a-workflow hazard. The `>= 500` degraded rule is sound.
- **Handler layering (`assertSameOrigin` → auth → Zod `safeParse` → service →
  `ok(...)`).** Confirmed in `show.post.ts` / `execute.post.ts`; the four new
  handlers (§7) match it, and `requireAuthenticatedUser` exists and returns
  `UserRow` (auth-only decision is applied faithfully).
- **Administration page: `ITEMS_PER_PAGE = 5` already set; destructure is
  `const { users, roles: rolesApi } = useApi()`; `canManage`, `toast`,
  `notifySuccess`, `notifyError`, `errorMessage` all exist.** All confirmed in
  `app/pages/administration/index.vue`. §11's merged destructure
  (`+ itop, n8n`), §11's helper reuse, and §11.1's verify-only pagination are
  accurate.
- **`DeviceCredentialsModal.vue` uses `UModal`.** Confirmed as the reusable modal
  pattern (`v-model:open`), though see Finding 2 for the one-line wiring note.
- **`mysql2` is not a direct dependency.** Confirmed absent from `package.json`;
  §9.4 correctly requires adding it pinned, user-run `npm install`.

## Unverified / Wrong Assumptions

- **WRONG (minor): §7's "`PERMISSIONS` … exported in `server/utils/auth`".**
  `PERMISSIONS` is exported from `#shared/constants/rbac`, not `server/utils/auth`.
  See Finding 1. This is a documentation inaccuracy, not a design flaw.
- **UNVERIFIED (correctly flagged by the design, out of this review's scope):**
  the exact iTop column names in §3.1 / §5 (and parent-`ticket` columns:
  `ref`, `title`, `operational_status`, `start_date`, `end_date`, `finalclass`,
  `caller_id`, `org_id`; `change`.`requestor_id` etc.). These are the fixed iTOP
  SCHEMA FACTS plus standard-iTop inferences; the design already carries an
  explicit CONFIRM-BEFORE-CODING planning note (§3.1) and makes every detail
  field optional so an absent column stays `undefined`. I did not (and per the
  constraints must not) re-verify these against the live `itop` DB; they are
  outside the repo and treated as given.
- **UNVERIFIED (environment): `mysql2@3.15.3` availability.** The design pins a
  version and instructs the planner to pick current stable if unavailable; I did
  not query the registry. Acceptable as written.
