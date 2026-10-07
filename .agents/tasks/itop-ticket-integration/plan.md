# Implementation Plan — iTop Ticket Integration

Derived from the APPROVED `design.md` (and `investigation.md` /
`admin-investigation.md`). All paths are absolute from the repo root
`e:\Work\CLOUD PROJECTS\Netops-policy`. Verification is `npm run typecheck` then
`npm run build` only (design N3 — no unit tests, no vitest config added). Per
AGENTS.md the USER runs all commands; each item below names the exact command to
run and the expected outcome.

Ordering follows the design's dependency chain: schemas + config + deps →
network client → service → endpoints → frontend → spec docs. Every item leaves
the tree buildable.

> CONFIRM-BEFORE-CODING (design §3.1): the exact iTop detail-table column names
> are the standard-iTop ITIL names and MUST be confirmed against the live `itop`
> schema before writing the SELECTs — a read-only `SHOW COLUMNS FROM <table>` or
> `SELECT * FROM <table> LIMIT 1` via `ITOP_DATABASE_URL`. If a column differs or
> is absent, DROP that one field (every detail-block field is optional); never
> invent a value. This is a planning/implementation confirmation, not a design
> re-decision.

---

- [ ] 1. Add `mysql2` as a pinned dependency.
      Add `"mysql2": "3.15.3"` to `dependencies` in `package.json` (pinned exact,
      matching the repo convention of pinning drivers like `postgres 3.4.9`,
      `argon2 0.45.1`, `ldapts 9.2.0`). If `3.15.3` is unavailable, pin the
      current stable 3.x exactly.
      Files: `package.json`
      Verify: user runs `npm install`; it completes and `node_modules/mysql2`
      exists. Then `npm run typecheck` still passes (no code uses it yet).

- [ ] 2. Add the `ITOP_UNREACHABLE` error code.
      Append `| 'ITOP_UNREACHABLE'` to the `ErrorCode` union in
      `server/utils/envelope.ts` (after `'INTERNAL_ERROR'`). `N8N_UNREACHABLE` is
      NOT added — the test endpoints return `ok({ ok:false })` and never throw.
      Files: `server/utils/envelope.ts`
      Verify: `npm run typecheck` passes.

- [ ] 3. Add optional iTop config to the env schema.
      Insert into the `z.object({...})` in `server/utils/config.ts` BEFORE the
      closing `})` that precedes `.refine(...)` (after the N8N block):
      `ITOP_DATABASE_URL: z.string().url('ITOP_DATABASE_URL must be a valid URL').optional()`
      and
      `ITOP_TIMEOUT_MS: z.coerce.number().int().positive('ITOP_TIMEOUT_MS must be a positive integer').default(10000)`,
      with the explanatory comment from design §9.2. Both optional so boot never
      breaks when iTop is unset (design R17).
      Files: `server/utils/config.ts`
      Verify: `npm run typecheck` passes; `npm run build` succeeds with
      `ITOP_DATABASE_URL` unset (boot resilience).

- [ ] 4. Add the `.env.example` iTop block.
      Append the commented iTop block from design §9.3, including the
      percent-encoding note (`#`→`%23`, `@`→`%40`, `:`→`%3A`, `/`→`%2F`), the
      commented `# ITOP_DATABASE_URL=mysql://USER:PASSWORD@HOST:3306/itop`, and
      `ITOP_TIMEOUT_MS=10000`. Never put a real value here.
      Files: `.env.example`
      Verify: file contains the block; `npm run build` unaffected.

- [ ] 5. Add the `shared/schemas/itop.schema.ts` Zod schemas.
      Create the file with the exact schemas from design §4:
      `ItopTicketTypeSchema`, `ItopTicketSearchSchema` (q 1..64, limit coerced
      int ≤50 default 20), `ItopTicketRefSchema` (ref 1..64),
      `ItopTicketSummarySchema`, `ItopTicketPartySchema`,
      `ItopTicketDetailBlockSchema` (all fields optional/nullable),
      `ItopTicketDetailSchema`, and `ConnectionTestResultSchema`
      (`{ ok, message }`, shared by both test endpoints). Types via `z.infer`;
      no hand-written interfaces.
      Files: `shared/schemas/itop.schema.ts`
      Verify: `npm run typecheck` passes.

- [ ] 6. Make `changeTicket` required in the ACL and Route field schemas.
      In `shared/schemas/acl.schema.ts` and `shared/schemas/route.schema.ts`
      drop `.optional()` on `changeTicket` in `AclFields` / `RouteFields` (becomes
      `changeTicket: ChangeTicketSchema`). `ChangeTicketSchema` in
      `shared/schemas/network.schema.ts` stays as-is. This flows into the
      add/delete/preview/execute schemas automatically.
      Files: `shared/schemas/acl.schema.ts`, `shared/schemas/route.schema.ts`
      Verify: `npm run typecheck` — expect it to now FLAG the four pages'
      `buildPayload()` (because `changeTicket: ... || undefined` with the `as`
      cast removed would mismatch). This flag is EXPECTED and is fixed in item 13;
      if the `as` cast is still present it will not flag yet (item 13 removes it).

- [ ] 7. Create the iTop network client `server/network/itop-client.ts`.
      New file mirroring `n8n-client.ts`: lazily-cached `mysql2/promise` pool from
      `loadEnv().ITOP_DATABASE_URL` (returns null when unset), `ItopUnreachableError`,
      and the `run()` helper whose AUTHORITATIVE deadline is a
      `Promise.race([work, setTimeout(reject, ITOP_TIMEOUT_MS)])` wrapping the WHOLE
      operation (connection acquire + query) — NOT the driver `timeout` option nor
      pool `connectTimeout` (design §5 Finding 1). Use the plain
      `conn.query(sql, params)` form. Export the parameterized SELECT-only
      functions: `searchTickets(q, limit)` (parent `ticket` only, `%q%` built in
      JS and bound, `LIMIT ?`), `getTicketByRef(ref)`,
      `getChangeDetail/getRequestDetail/getIncidentDetail/getProblemDetail(id)`
      (backtick `` `change` ``; NormalChange LEFT JOIN `change_normal`),
      `resolveContacts(ids)` / `resolveOrganizations(ids)` (params `[ids]` WRAPPED
      not spread, empty-array guard `if (ids.length === 0) return []` BEFORE the
      call — design §5 Finding 2), and `pingItop()` (never-throws `SELECT 1`).
      Confirm detail columns per the §3.1 CONFIRM-BEFORE-CODING note; drop absent
      columns.
      Files: `server/network/itop-client.ts`
      Verify: `npm run typecheck` passes.

- [ ] 8. Add `pingN8n()` to `server/network/n8n-client.ts`.
      Append the never-throwing, `N8N_TIMEOUT_MS`-bounded probe from design §8:
      GET the n8n origin ROOT (`${base.protocol}//${base.host}/`, derived from
      `N8N_BASE_URL` via `new URL`), no API key on the wire. HTTP `>= 500` →
      `{ ok:false, 'n8n host responded HTTP <n> — service may be down' }` (degraded,
      R14); sub-500 → `{ ok:true }`; transport error/timeout → `{ ok:false }`.
      Return type `ConnectionTestResult` imported from `#shared/schemas/itop.schema`.
      Files: `server/network/n8n-client.ts`
      Verify: `npm run typecheck` passes.

- [ ] 9. Create the iTop service `server/services/itop.service.ts`.
      New file with the pure `resolveClass(finalclass): ItopClassInfo` resolver
      (design §3 mapping table — driven by `finalclass`, not ref prefix; unknown →
      `type: 'Unknown'`, empty detail block), `searchItopTickets(input)` (calls
      `searchTickets(input.q, input.limit)`, maps rows → `ItopTicketSummary`,
      dates → string), and `getItopTicketDetail(ref)` (getTicketByRef → null→null;
      resolveClass → fetch type detail; collect caller/requestor + org ids,
      de-duplicated, call resolveContacts/resolveOrganizations; assemble
      `ItopTicketDetail` strictly per the §3.1 column→field mapping). Never return
      raw rows — shape to the Zod response schema.
      Files: `server/services/itop.service.ts`
      Verify: `npm run typecheck` passes.

- [ ] 10. Create the search + preview endpoints.
      New thin handlers (design §7): `server/api/itop/tickets/search.post.ts` and
      `server/api/itop/tickets/preview.post.ts`. Both: `assertSameOrigin(event)` →
      `requireAuthenticatedUser(event)` (auth only, NO new RBAC permission) → Zod
      validate (`ItopTicketSearchSchema` / `ItopTicketRefSchema`, 400
      `VALIDATION_ERROR` on failure) → service → `ok(...)`; catch
      `ItopUnreachableError` → `apiError(502, 'ITOP_UNREACHABLE', 'iTop is unreachable')`;
      preview null → `apiError(404, 'NOT_FOUND', 'Ticket not found')`. Use EXPLICIT
      relative imports at THREE levels (`../../../utils/*`, `../../../services/*`,
      `../../../network/*`); schema types via `#shared/schemas/itop.schema`.
      Files: `server/api/itop/tickets/search.post.ts`,
      `server/api/itop/tickets/preview.post.ts`
      Verify: `npm run typecheck` passes.

- [ ] 11. Create the two Test Connection endpoints.
      New handlers `server/api/itop/test.post.ts` and `server/api/n8n/test.post.ts`
      (design §7): `assertSameOrigin(event)` →
      `requirePermission(event, PERMISSIONS.ADMINISTRATION_MANAGE)` →
      `return ok(await pingItop())` / `return ok(await pingN8n())`. These are TWO
      levels below `server/` → imports `../../utils/*`, `../../network/*`;
      `PERMISSIONS` from `#shared/constants/rbac` (match `acl/show.post.ts`).
      Files: `server/api/itop/test.post.ts`, `server/api/n8n/test.post.ts`
      Verify: `npm run typecheck` passes; `npm run build` succeeds.

- [ ] 12. Add the `itop` and `n8n` groups to `app/composables/useApi.ts`.
      Add the two groups from design §10.4: `itop.searchTickets(q, limit=20)` →
      POST `/api/itop/tickets/search`, `itop.getTicket(ref)` → POST
      `/api/itop/tickets/preview`, `itop.testConnection()` → POST `/api/itop/test`,
      and `n8n.testConnection()` → POST `/api/n8n/test` (all via `apiSend`). Import
      `ItopTicketSummary`, `ItopTicketDetail`, `ConnectionTestResult` types from
      `#shared/schemas/itop.schema`.
      Files: `app/composables/useApi.ts`
      Verify: `npm run typecheck` passes.

- [ ] 13. Create `app/components/ItopTicketModal.vue` and rewrite the four forms.
      New modal (design §10.2): a `UModal` (pattern from `DeviceCredentialsModal.vue`)
      with a forced-light search `UInput`, brand search button + Enter, results list
      (ref mono + type pill + truncated title) via `useApi().itop.searchTickets`,
      the three shared states (`LoadingState` / `EmptyState` icon `i-lucide-ticket` /
      `ErrorState` with retry), a preview card via `itop.getTicket(ref)`, and a
      "Use this ticket" brand button emitting `selected`. Props
      `{ modelValue: boolean }`; emits `update:modelValue` + `selected`
      `[ItopTicketSummary]`. XSS rule: render EVERY iTop string via `{{ }}` only —
      NO `v-html`, no raw-HTML sink (design §10.2 / R6). Token classes only;
      icon-only buttons get `aria-label`; do NOT restyle `FormField`.
      Then in each of `app/pages/acl/add.vue`, `app/pages/acl/delete.vue`,
      `app/pages/routes/add.vue`, `app/pages/routes/delete.vue` (design §10.3):
      (a) swap the raw `changeTicket` `<input>` for a readonly display (`:value`,
      `placeholder="No ticket selected"`) + a "Select ticket" `UButton` and add
      `<ItopTicketModal v-model="ticketModalOpen" @selected="onTicketSelected" />`;
      keep label "Ticket Change" and `name="changeTicket"`, add `required`;
      (b) add `ticketModalOpen`, `selectedTicket`, `onTicketSelected` (sets
      `form.changeTicket = t.ref`); (c) in `buildPayload()` send
      `changeTicket: form.changeTicket` and REMOVE the `as AclPreviewInput` /
      `as RoutePreviewInput` cast (prefer no annotation, fall back to `satisfies`,
      never `as` — design §4.1); (d) append `|| !form.changeTicket` to the Generate
      button's EXISTING `:disabled` (ACL: `generating || !ipsValid || !form.changeTicket`;
      Route: `generating || !ipValid || !form.changeTicket`); (e) add the
      `text-muted` helper note "Select a change ticket to enable Generate." when
      `!form.changeTicket`; (f) clear `selectedTicket.value = null` in
      `resetFields()`. Do NOT modify the existing `watch(form, ...)`.
      Files: `app/components/ItopTicketModal.vue`, `app/pages/acl/add.vue`,
      `app/pages/acl/delete.vue`, `app/pages/routes/add.vue`,
      `app/pages/routes/delete.vue`
      Verify: `npm run typecheck` passes (this resolves the item-6 flag — the four
      `buildPayload()` now satisfy the required `changeTicket` with no cast);
      `npm run build` succeeds.

- [ ] 14. Add the Test Connection buttons to the Administration page.
      In `app/pages/administration/index.vue` (design §11): add a `v-if="canManage"`
      "Connections" section after the `<Pagination>` block with two neutral-outline
      `UButton`s (`i-lucide-plug`, labels "Test iTop Connection" / "Test n8n
      Connection", per-button `:loading`). Merge the existing useApi destructure to
      `const { users, roles: rolesApi, itop, n8n } = useApi()` (do NOT add a second
      `useApi()` call); add `itopTesting`/`n8nTesting` refs and `testItop`/`testN8n`
      handlers reusing the page's existing `notifySuccess`/`notifyError` toast
      helpers and `errorMessage`.
      Files: `app/pages/administration/index.vue`
      Verify: `npm run typecheck` passes; `npm run build` succeeds.

- [ ] 15. Verify (do NOT edit) User-Mapping pagination at 5.
      Confirm `const ITEMS_PER_PAGE = 5` in `app/pages/administration/index.vue`
      and that `<Pagination v-if="total > ITEMS_PER_PAGE">` + `users.list({ page,
      limit: ITEMS_PER_PAGE })` are wired (already applied; design §11.1). No code
      change.
      Files: none (verification only)
      Verify: `read` the file and confirm `ITEMS_PER_PAGE = 5` is present and the
      Pagination block references it.

- [ ] 16. Update the spec docs.
      Per design §13: in `.kiro/specs/n8n-integration/requirements.md` add EARS
      requirements R1–R17; in `.kiro/specs/n8n-integration/design.md` note
      `changeTicket` is now REQUIRED and carries the selected iTop `ref` and add a
      sibling subsection to "Device Session Credentials" for the ticket picker +
      the `pingN8n`/`pingItop` test endpoints. In
      `.kiro/specs/netops-policy-manager/design.md` add `itop.schema.ts` to Zod
      Application Schemas, the four `/api/itop/*` + `/api/n8n/test` rows to the API
      Endpoints table, `ItopTicketModal.vue` to Frontend Components, and the
      `ITOP_DATABASE_URL` + `ITOP_TIMEOUT_MS` rows to config/env. Do NOT touch Log
      Trail code or audit read endpoints.
      Files: `.kiro/specs/n8n-integration/requirements.md`,
      `.kiro/specs/n8n-integration/design.md`,
      `.kiro/specs/netops-policy-manager/design.md`
      Verify: docs contain the new sections; `npm run build` unaffected.

- [ ] 17. Final full verification.
      Run the project's full checks after all edits.
      Files: none
      Verify: `npm run typecheck` passes with no errors AND `npm run build`
      succeeds. Confirm each of the four pages' `buildPayload()` sends
      `changeTicket: form.changeTicket` with NO `|| undefined` and NO `as *Input`
      cast (design §14 belt-and-suspenders check).
