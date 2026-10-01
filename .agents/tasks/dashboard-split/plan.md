# Implementation Plan — Split dashboard into five independent, async widget endpoints

## Goal

Replace the single combined `GET /api/dashboard/summary` with FIVE independent GET
endpoints, one per widget. Each endpoint gets its own service function and its own
`useApi` client method so the frontend fires all five in parallel; each widget shows
its own loading / error / data state (fast widgets render first, a slow one never
blocks the others).

NO DB schema change, NO migration — pure SQL aggregation over `audit_logs`. This is a
**decomposition, not a logic rewrite**: the exact aggregation semantics below are
copied from the current `server/services/dashboard.service.ts` and must be preserved.

## Constraints for the coder

- **DO NOT run any CLI commands.** No `npm run typecheck`, no build, no git, no
  installs. The user runs those. Verify your work by **re-reading** the files you
  changed and checking the points called out in each item's Verify line.
- Match existing patterns. Thin handler → service; envelope `{ success, data }` via
  `ok()`; `requireAuthenticatedUser(event)` only (dashboard is common access, **NO
  feature permission**); never return raw DB rows; keep Drizzle queries directly in
  the service (no new repository).
- Response types are plain TS interfaces (no Zod dashboard schema — none exists), and
  the same interface shapes are mirrored in `useApi.ts` and `index.vue` (the existing
  duplicated-interface convention).
- No new dependency, no charting library. Plain SVG/div bars only. Tokens only
  (`bg-surface`, `bg-panel`, `border-line`/`ring-line`, `text-ink`, `text-muted`,
  `bg-brand`, `text-ok`, `text-bad`) — no hex. English copy.
- Do NOT fake activity data. Real dev data is sparse (activity only on 2026-09-25 and
  2026-10-01); the chart must render gracefully with few / zero-value buckets.

## Exact aggregation semantics to preserve (quoted from current service)

These SQL fragments and query bodies currently live in `summary()` and must move into
the new per-widget functions **unchanged**:

Shared fragments (keep as module-level consts, reused across functions):
```ts
const inThisMonth = sql`${auditLogs.createdAt} >= date_trunc('month', now())`
const inLastMonth = sql`${auditLogs.createdAt} >= date_trunc('month', now()) - interval '1 month' and ${auditLogs.createdAt} < date_trunc('month', now())`
const isConfigChange = sql`${auditLogs.module} in ('ACL','ROUTE') and ${auditLogs.action} in ('ADD','DELETE')`
```
Helpers to keep: `num(value)` (coerce postgres.js string counts) and
`rate(success, total)` = `total > 0 ? Math.round((success/total)*100) : 0`.

- **KPI** — one grouped query over `auditLogs` with `count()` + `count(*) filter (where …)`:
  `totalAll`, `totalThis` (inThisMonth), `totalLast` (inLastMonth), `successAll/This/Last`
  (`status = 'SUCCESS'` [+ month window]), `cfgAll/This/Last` (`isConfigChange` [+ month window]).
  Then: `totalActivity = { value: totalAll, delta: totalThis - totalLast }`,
  `configChanges = { value: cfgAll, delta: cfgThis - cfgLast }`,
  `successRate = { value: rate(successAll,totalAll), delta: rate(successThis,totalThis) - rate(successLast,totalLast) }`.
  (Success Rate delta is in **percentage points**; the other two are **count** deltas.)
- **Daily** — `to_char(date_trunc('day', createdAt), 'YYYY-MM-DD')`, where
  `createdAt >= date_trunc('day', now()) - interval '13 days'`, group+order by `date_trunc('day', …)`.
- **Weekly** — `to_char(date_trunc('week', createdAt), 'IYYY-"W"IW')`, where
  `createdAt >= date_trunc('week', now()) - interval '11 weeks'`, group+order by `date_trunc('week', …)`.
- **Monthly** — `to_char(date_trunc('month', createdAt), 'YYYY-MM')`, where
  `createdAt >= date_trunc('month', now()) - interval '11 months'`, group+order by `date_trunc('month', …)`.
- **Config by operation** — `select module, action, count()` where `isConfigChange`,
  group by `module, action`; then zero-fill into the FIXED ordered four:
  `['ROUTE/ADD','ROUTE/DELETE','ACL/ADD','ACL/DELETE']` via a `Map` of `${module}/${action} -> count`.
- **Top users** — `select username, count()` group by `username`, `orderBy(desc(sql\`count(*)\`))`,
  `limit(8)`; map `username ?? '—'`.
- **Recent config changes** — safe projection `{ id, module, action, username, status, createdAt }`
  where `isConfigChange`, `orderBy(desc(createdAt))`, `limit(8)`; map `createdAt.toISOString()`.
  NO JSONB payloads, NO raw rows.

## Response shapes (new)

```ts
// kpi
interface Kpi { totalActivity: KpiDelta, configChanges: KpiDelta, successRate: KpiDelta }
interface KpiDelta { value: number, delta: number }

// activity-series — ALL THREE in one response
interface ActivitySeries { daily: SeriesPoint[], weekly: SeriesPoint[], monthly: SeriesPoint[] }
interface SeriesPoint { bucket: string, count: number }

// config-by-operation
interface ConfigByOperationResult { items: ConfigByOperation[] }
interface ConfigByOperation { operation: string, count: number }   // keep key name `operation` (matches current UI)

// top-users
interface TopUsersResult { items: TopUser[] }
interface TopUser { username: string, count: number }

// recent-config-changes
interface RecentConfigChangesResult { items: RecentConfigChange[] }
interface RecentConfigChange { id: string, module: string, action: string, username: string | null, status: string, createdAt: string }
```
Note: the task brief sketches a richer KPI shape (`deltaPct`/`direction`/`deltaPp`).
**Keep the existing `{ value, delta }` shape** — the brief says preserve exact delta
semantics, and the current UI computes direction/sign from `delta` client-side.
Keeping `delta` avoids a logic rewrite and keeps the KPI template unchanged.
Likewise keep `operation` (not `key`) so the Config-by-Operation template is untouched.

---

# Items

- [ ] 1. Rewrite `server/services/dashboard.service.ts`: split `summary()` into five exported functions.
      Keep the module-level `inThisMonth` / `inLastMonth` / `isConfigChange` consts and the
      `num()` / `rate()` helpers. Keep imports `count, desc, sql` from `drizzle-orm`, the
      `Database` type from `~~/database`, and `auditLogs` from `~~/database/schema/audit-logs`.
      Export these interfaces + functions, moving the matching query body from the old `summary()`
      into each (semantics above, unchanged):
        - `interface Kpi` + `getKpi(db: Database): Promise<Kpi>` (the KPI grouped FILTER query).
        - `interface ActivitySeries`/`SeriesPoint` + `getActivitySeries(db): Promise<ActivitySeries>`
          running daily/weekly/monthly with `await Promise.all([...])` and returning
          `{ daily, weekly, monthly }` (each mapped via the existing `toSeries` logic).
        - `interface ConfigByOperation`/`ConfigByOperationResult` + `getConfigByOperation(db): Promise<ConfigByOperationResult>`
          returning `{ items }` with the fixed-four zero-fill.
        - `interface TopUser`/`TopUsersResult` + `getTopUsers(db): Promise<TopUsersResult>` returning `{ items }`.
        - `interface RecentConfigChange`/`RecentConfigChangesResult` + `getRecentConfigChanges(db): Promise<RecentConfigChangesResult>`
          returning `{ items }` (safe projection, ISO createdAt).
      DELETE the old `summary()` function and the combined `DashboardSummary` interface (now unused).
      Keep the module doc-comment, trimmed to describe the five functions.
      Files: `server/services/dashboard.service.ts`
      Verify (re-read): no reference to `summary` or `DashboardSummary` remains in the file;
      all five functions are `export`ed; `count`, `desc`, `sql` all still used (no unused import under
      TS strict); each function returns the shape declared above; the three SQL fragments are byte-for-byte
      the same as the original (`date_trunc` windows, `'IYYY-"W"IW'`, the fixed-four order).

- [ ] 2. Create `server/api/dashboard/kpi.get.ts` — thin handler.
      Mirror `server/api/dashboard/summary.get.ts`: `defineEventHandler(async (event) => { await
      requireAuthenticatedUser(event); return ok(await getKpi(useDatabase())) })`. Import `getKpi`
      from `../../services/dashboard.service`, `requireAuthenticatedUser` from `../../utils/auth`,
      `useDatabase` from `../../utils/db`, `ok` from `../../utils/envelope`, `defineEventHandler` from `h3`.
      NO feature permission.
      Files: `server/api/dashboard/kpi.get.ts`
      Verify (re-read): imports resolve to the same relative paths the summary handler used;
      calls `getKpi`; wraps with `ok()`; only `requireAuthenticatedUser` (no `requirePermission`).

- [ ] 3. Create `server/api/dashboard/activity-series.get.ts` — thin handler calling `getActivitySeries`.
      Same pattern as item 2. File name uses the hyphen so the route is `/api/dashboard/activity-series`.
      Files: `server/api/dashboard/activity-series.get.ts`
      Verify (re-read): route path matches `/api/dashboard/activity-series`; calls `getActivitySeries`;
      auth-only; `ok()` envelope.

- [ ] 4. Create `server/api/dashboard/config-by-operation.get.ts` — thin handler calling `getConfigByOperation`.
      Same pattern as item 2.
      Files: `server/api/dashboard/config-by-operation.get.ts`
      Verify (re-read): route `/api/dashboard/config-by-operation`; calls `getConfigByOperation`;
      auth-only; `ok()`.

- [ ] 5. Create `server/api/dashboard/top-users.get.ts` — thin handler calling `getTopUsers`.
      Same pattern as item 2.
      Files: `server/api/dashboard/top-users.get.ts`
      Verify (re-read): route `/api/dashboard/top-users`; calls `getTopUsers`; auth-only; `ok()`.

- [ ] 6. Create `server/api/dashboard/recent-config-changes.get.ts` — thin handler calling `getRecentConfigChanges`.
      Same pattern as item 2.
      Files: `server/api/dashboard/recent-config-changes.get.ts`
      Verify (re-read): route `/api/dashboard/recent-config-changes`; calls `getRecentConfigChanges`;
      auth-only; `ok()`.

- [ ] 7. Delete the old combined endpoint `server/api/dashboard/summary.get.ts`.
      Files: delete `server/api/dashboard/summary.get.ts`
      Verify (grep then re-read): `grep -r "dashboard/summary"` across `app/` and `server/` returns
      no live references (only the `.agents/tasks/**` docs may mention it — those are historical notes,
      ignore). Confirm the file no longer exists.

- [ ] 8. Rewrite the dashboard client methods in `app/composables/useApi.ts`.
      Remove the local `DashboardSummary` interface and the old `KpiDelta`/`SeriesPoint`/
      `ConfigByOperation`/`TopUser`/`RecentConfigChange` block, and the `dashboard.summary()` method.
      Add the five new response interfaces (from the "Response shapes" section above) and replace the
      `dashboard` object with five methods, each a one-liner over the existing `apiGet<T>` helper
      (which already unwraps the envelope and is SSR-safe):
        - `kpi(): Promise<Kpi>` → `apiGet<Kpi>('/api/dashboard/kpi')`
        - `activitySeries(): Promise<ActivitySeries>` → `apiGet<ActivitySeries>('/api/dashboard/activity-series')`
        - `configByOperation(): Promise<ConfigByOperationResult>` → `apiGet<…>('/api/dashboard/config-by-operation')`
        - `topUsers(): Promise<TopUsersResult>` → `apiGet<…>('/api/dashboard/top-users')`
        - `recentConfigChanges(): Promise<RecentConfigChangesResult>` → `apiGet<…>('/api/dashboard/recent-config-changes')`
      Files: `app/composables/useApi.ts`
      Verify (re-read): no `DashboardSummary` / `summary` remains in the file; five methods exist with
      the URLs above; each return type matches the service interface in item 1; no other section
      (auth, aclOps, audit, users, roles …) changed.

- [ ] 9. Rebuild `app/pages/index.vue` so each widget owns its async state and fetches its own endpoint in parallel.
      Replace the single `summary`/`pending`/`error`/`load()` model with FIVE independent states, each a
      small `{ data: ref(null), pending: ref(true), error: ref(false) }` plus a `load` function that
      sets its own refs. In `onMounted`, call all five `load` functions WITHOUT `await` between them
      (fire in parallel — e.g. call each `loadX()` so they run concurrently; do not `await` them in
      sequence). Mirror the five interfaces locally (same shapes as item 8).
      Per-widget state shape (one per widget):
        - KPI:      `kpiData: Ref<Kpi|null>`, `kpiPending`, `kpiError`, `loadKpi()`
        - Series:   `seriesData: Ref<ActivitySeries|null>`, `seriesPending`, `seriesError`, `loadSeries()`
        - Config:   `configData: Ref<ConfigByOperation[]|null>` (unwrap `.items`), `configPending`, `configError`, `loadConfig()`
        - Users:    `usersData: Ref<TopUser[]|null>` (unwrap `.items`), `usersPending`, `usersError`, `loadUsers()`
        - Recent:   `recentData: Ref<RecentConfigChange[]|null>` (unwrap `.items`), `recentPending`, `recentError`, `loadRecent()`
      Each `loadX()`: set `pending=true, error=false`; `try` assign data; `catch` set `error=true`;
      `finally` set `pending=false`. Each widget renders `LoadingState` while its own `pending`,
      `ErrorState` (with `@retry="loadX"` — re-fetches ONLY that widget) on its own `error`, and
      `EmptyState` when its data is empty.
      Keep the visuals identical to the current approved design:
        - KPI row: three cards, no icons, deltas; reuse the current `deltaCount()` helper and the
          Success-Rate up/down arrow + `pp` logic (reads `kpiData.*.delta`).
        - Activity Over Time: bar chart + Daily/Weekly/Monthly toggle. The toggle stays CLIENT-SIDE over
          the single `seriesData` response (no refetch): keep `granularity` ref and the `activeSeries`
          computed, but source it from `seriesData.value?.daily|weekly|monthly`. Keep `barHeight`,
          `seriesLabel`, `maxSeriesCount`. The chart already handles sparse/zero buckets
          (min 2% height for non-zero bars) — keep that so the two real days (2026-09-25, 2026-10-01)
          stay visible; render only existing buckets (do not synthesize empty days).
        - Config Changes by Operation: keep the `op.operation.replace('/', ' / ')` bars + `configBarWidth`
          / `maxConfigOp` over `configData`.
        - Top Active Users: rank `#index+1` + name + count, over `usersData`.
        - Recent Config Changes: feed with inline SUCCESS/FAILED colored label (`text-ok`/`text-bad`) —
          do NOT use StatusBadge; keep `formatTime()`.
      Each widget sits in its own `<div>` block so one widget's LoadingState/ErrorState does not hide the
      others (remove the single page-level `LoadingState`/`ErrorState` that wrapped everything).
      Files: `app/pages/index.vue`
      Verify (re-read): no `dashboard.summary()` call and no combined `summary` ref remain; `onMounted`
      triggers all five loads concurrently (no sequential `await` chain); each widget block references
      only its own `*Data`/`*Pending`/`*Error` and its own `ErrorState @retry`; the granularity toggle
      reads from `seriesData` and triggers no network call; only token classes used (no hex); copy is
      English; `LoadingState`, `ErrorState`, `EmptyState`, `PageHeader` are the same components imported
      (auto-imported, confirmed present at `app/components/`).

- [ ] 10. Final consistency pass (re-read only, no CLI).
      Confirm end-to-end: the five service functions ↔ five handlers ↔ five `useApi` methods ↔ five
      `index.vue` widget loaders all agree on route path and response shape; no symbol named `summary`
      or `DashboardSummary` survives in `server/services/dashboard.service.ts`, `server/api/dashboard/`,
      `app/composables/useApi.ts`, or `app/pages/index.vue`; `server/api/dashboard/summary.get.ts` is gone.
      Files: none (verification)
      Verify (grep): `grep -rn "summary\|DashboardSummary" server/services/dashboard.service.ts server/api/dashboard app/composables/useApi.ts app/pages/index.vue`
      returns nothing. (Historical mentions under `.agents/tasks/**` are fine.)

## Notes / assumptions

- KPI response keeps `{ value, delta }` rather than the richer `deltaPct/direction/deltaPp`
  sketch in the brief, because the brief's overriding instruction is "KEEP exact delta semantics"
  and the current UI derives direction/sign from `delta`. This avoids a logic rewrite and keeps
  the KPI template unchanged. If the richer shape is later wanted, it is an additive follow-up.
- `ConfigByOperation` keeps the field name `operation` (not `key`) so the existing
  `op.operation.replace(...)` template needs no change; it already yields the four
  `ROUTE/ADD … ACL/DELETE` keys.
- `activity-series` returns all three series in one response (as specified) so the Daily/Weekly/Monthly
  toggle is instant and never refetches.
- No DB, schema, migration, dependency, or charting-library change. Verification is by re-reading
  because the coder must not run CLI commands; the user runs `npm run typecheck` afterward.
