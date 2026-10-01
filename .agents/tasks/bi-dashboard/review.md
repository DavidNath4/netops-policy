# BI Dashboard rebuilt on real audit_logs aggregation

The dashboard page and its backing service were replaced wholesale to show the five user-approved widgets, all computed by SQL aggregation over `audit_logs` (no hardcoded numbers, no charting library). The old execution-summary shape (`totalExecutions`/`successCount`/`failedCount`/`perModule`/`recentActivities`/`failedRecent`) is gone; the new `DashboardSummary` carries three KPI deltas, three pre-computed time series, a fixed four-row config-operation breakdown, top users, and a safe recent-config-change feed. The handler, envelope, auth, and DB schema are untouched, and the change is confined to exactly three files.

Watch for: nothing blocking. Minor behavioral notes only — a Success Rate delta of exactly 0 renders in green with an up-arrow (confirmed), and the KPI month-delta sign uses a Unicode minus `−` which is intentional display, not a bug.

**Verdict**: APPROVED

## High-level view

The five widgets map one-to-one onto the approved set and nothing extra was added. The KPI row is three icon-less cards (Total Activity, Config Changes, Success Rate), each with a static "vs last month" delta; Total Activity and Config Changes use a muted tone while Success Rate alone gets the green-up/red-down treatment, matching the "higher-is-better operational health" intent. Activity Over Time is a plain-SVG-free div bar chart whose Daily/Weekly/Monthly toggle flips between three series already in the payload — no refetch, independent of the KPI deltas. Config Changes by Operation is the fixed four-row ROUTE/ADD, ROUTE/DELETE, ACL/ADD, ACL/DELETE set, zero-filled server-side. Top Active Users is count-only ranking (no role, no failed column). Recent Config Changes is a safe projection feed with inline colored status labels.

The aggregation is all real Drizzle SQL over `audit_logs`. Month windows are evaluated entirely in the DB via `date_trunc('month', now())`, so current-vs-previous deltas are server-consistent against the timestamptz column with no Node/DB timezone drift. The config-change predicate `module IN ('ACL','ROUTE') AND action IN ('ADD','DELETE')` is defined once as a reusable SQL fragment and applied consistently to the config KPI, the operation breakdown, and the recent feed, so SHOW/LOGIN/UPDATE and other noise are excluded everywhere it matters.

The response shape stays a plain duplicated TS interface (service + `useApi.ts` + page), matching the existing convention — no Zod schema was introduced, and no new repository was carved out; the service keeps querying Drizzle directly as it already did. The recent feed selects an explicit safe column list, never raw rows, so no JSONB payloads or secrets can leak. Design tokens are used throughout and all copy/comments are English.

<details>
<summary>Issues (0)</summary>

No blocking or actionable findings. Two non-actionable observations are noted in the body (Success-Rate zero-delta tone, Unicode minus glyph) — both are intentional display behavior.

</details>

<details>
<summary>Details</summary>

## Widget inventory matches the approved five exactly

The page renders precisely the approved set, no more, no fewer (`app/pages/index.vue`). The KPI grid is `sm:grid-cols-3` with three cards and no `UIcon` anywhere — the old icon-bearing `StatCard` abstraction and the fourth "ACL / Route Activity" card were removed. Activity Over Time, Config Changes by Operation, Top Active Users, and Recent Config Changes each appear once. There is no leftover "Activity by Module" / per-module list, no outcome widget, no failures-by-operation, no authentication widget — the earlier descoping decisions from the conversation are respected.

Config Changes by Operation iterates `summary.configByOperation`, which the server fixes to the four-element order `['ROUTE/ADD','ROUTE/DELETE','ACL/ADD','ACL/DELETE']` and zero-fills via a lookup map (`dashboard.service.ts`), so missing combinations still render as empty tracks and the widget never collapses. Top Active Users renders rank + username + count only; there is no role column and no failed column.

## Real aggregation, config-change predicate applied consistently

Every number comes from Drizzle queries over `auditLogs`; there are no literals. The config-change filter is defined once as `isConfigChange = sql\`${auditLogs.module} in ('ACL','ROUTE') and ${auditLogs.action} in ('ADD','DELETE')\`` and reused in the KPI FILTER clauses, the `cfgRowsQuery` WHERE, and the `recentQuery` WHERE. This guarantees SHOW and non-ADD/DELETE actions are excluded uniformly across the config KPI, the operation bars, and the recent feed — a single source of truth that avoids the drift risk of three separately-written predicates.

## KPI deltas: static, server-consistent month windows

`inThisMonth` and `inLastMonth` are DB-side fragments built on `date_trunc('month', now())`, so the this-vs-last-month boundaries are computed in Postgres against the timestamptz `created_at` with no client clock involved. `totalActivity.delta = totalThis − totalLast` and `configChanges.delta = cfgThis − cfgLast` are plain count deltas; `successRate.delta = rate(successThis,totalThis) − rate(successLast,totalLast)` is a percentage-point change, with `rate()` guarding division by zero (returns 0 for an empty window). All counts pass through `num()` before arithmetic, which addresses the postgres.js string-coercion hazard the plan flagged.

The deltas are entirely decoupled from the chart's granularity toggle — they are fields on the payload, computed once server-side, and the client never recomputes them when `granularity` changes. In the UI, Total Activity and Config Changes render their delta in `text-muted` (neutral), while Success Rate uses `text-ok`/`text-bad` with ▲/▼ and a `pp` suffix. This is exactly the tone split the requirements call for.

One behavioral note (not a defect): a Success Rate delta of exactly `0` satisfies `delta >= 0`, so it renders green with an up-arrow. That is a defensible reading of "non-negative is good" and matches the plan's stated `delta >= 0` branch, so it is left as-is.

## Three series in one payload, client-side toggle

`dailyQuery`/`weeklyQuery`/`monthlyQuery` each `date_trunc` + `group by` + `order by` the same truncation expression, windowed to the last ~14 days / ~12 weeks / ~12 months, and format the bucket to a stable string in SQL (`YYYY-MM-DD`, `IYYY-"W"IW`, `YYYY-MM`). All three ship in the single summary response. The page's `activeSeries` computed simply selects one of the three off `granularity`, so switching Daily/Weekly/Monthly is instant with no network call. `maxSeriesCount` and `barHeight` scale bars to the tallest, with a 2% floor so a non-zero bar is always visible and zero stays at 0%. An empty active series falls back to `EmptyState` rather than rendering a broken chart — important given the dev dataset only spans one week, so weekly/monthly will be sparse.

`seriesLabel` parses each bucket key back to a readable axis label per granularity, with `Number.isNaN` fallbacks to the raw bucket if parsing fails. The weekly branch extracts the ISO week number by regex off the `...-Wnn` key, which lines up with the server's `to_char(..., 'IYYY-"W"IW')` format.

## topUsers and recent feed shapes

`usersQuery` groups by `auditLogs.username`, orders `desc(count(*))`, limits 8, and the service maps null usernames to `'—'`. One person is one row with summed counts because the grouping key is the username column. The recent feed selects only `id, module, action, username, status, createdAt` — an explicit safe column list, never `select()` of the whole row — so none of the four JSONB payloads (which the schema notes carry redacted-but-sensitive execution data) can reach the client. `createdAt` is mapped to an ISO string via `.toISOString()`, valid since the column is a JS `Date`.

## Status rendering and tokens

SUCCESS/FAILED in the recent feed is an inline `<span>` colored `text-ok`/`text-bad`, not the shared `StatusBadge` — matching requirement 8 and the Log Trail convention. Across the whole page the only colors used are token utilities (`bg-surface`, `bg-panel`, `border-line`, `ring-line`, `text-ink`, `text-muted`, `bg-brand`, `text-ok`, `text-bad`); no hex literals appear. The granularity toggle buttons are `type="button"` text buttons styled with `bg-brand text-white` (active) vs `bg-surface text-muted` (inactive), consistent with the UI conventions, and they carry visible text labels so no `aria-label` is required.

## Scope and client/server type parity

`git diff main --name-only` shows exactly three files: `app/composables/useApi.ts`, `app/pages/index.vue`, `server/services/dashboard.service.ts`. `package.json` has no diff (no charting dependency), `database/` has no diff (no migration, schema untouched), and `server/api/dashboard/summary.get.ts` is unchanged — still the thin `requireAuthenticatedUser` → `ok(await summary(useDatabase()))` handler returning the mapped shape, never raw rows. Log Trail, auth, and ACL/ROUTE services were not touched.

The new `DashboardSummary` interface and its five helper interfaces are declared identically in the service (exported) and mirrored verbatim in both `useApi.ts` and `index.vue`, preserving the existing duplicated-plain-interface convention rather than introducing a Zod schema. `dashboard.summary()` keeps its `apiGet<DashboardSummary>` envelope-unwrap, and the removed `AuditResponse`/`toAuditResponse`/`eq` imports are no longer referenced in the files that dropped them (`useApi.ts` keeps `AuditResponse` for its other return types).

</details>

<details>
<summary>File map</summary>

- `server/services/dashboard.service.ts` — replaced `summary()` body and `DashboardSummary` shape with seven aggregation queries (KPI FILTER totals, three `date_trunc` series, config-op breakdown, top users, safe recent feed); dropped `eq`/`toAuditResponse`/`AuditResponse` imports.
- `app/composables/useApi.ts` — swapped the client `DashboardSummary` interface (+5 helper interfaces) to match the new server shape; `dashboard.summary()` unchanged.
- `app/pages/index.vue` — rebuilt the template and script to render the five widgets with the client-side granularity toggle; removed the icon `StatCard` model and per-module/recent-activity sections.

Full diff: `git --no-pager diff main`.
</details>
