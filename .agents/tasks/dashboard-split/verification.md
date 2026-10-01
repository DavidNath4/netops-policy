# Verification — Split dashboard into five independent widget endpoints

First iteration (no `review.json` present). Implemented from `plan.md`.
Verification is by RE-READING only (no CLI run, per the task constraint).

## Files created

- `server/api/dashboard/kpi.get.ts`
- `server/api/dashboard/activity-series.get.ts`
- `server/api/dashboard/config-by-operation.get.ts`
- `server/api/dashboard/top-users.get.ts`
- `server/api/dashboard/recent-config-changes.get.ts`

## Files changed

- `server/services/dashboard.service.ts` — split `summary()` into five exported
  functions.
- `app/composables/useApi.ts` — replaced `dashboard.summary()` with five methods.
- `app/pages/index.vue` — rebuilt so each widget owns its async state and fetches
  its own endpoint in parallel.

## Files deleted

- `server/api/dashboard/summary.get.ts` (confirmed gone via file_search — no match).

## What I confirmed by re-reading

### Service (`dashboard.service.ts`)
- Five functions exported: `getKpi`, `getActivitySeries`, `getConfigByOperation`,
  `getTopUsers`, `getRecentConfigChanges`. No `summary` symbol, no
  `DashboardSummary` interface remain.
- Imports unchanged and all still used: `count`, `desc`, `sql` from `drizzle-orm`;
  `Database` type from `~~/database`; `auditLogs` from `~~/database/schema/audit-logs`.
  - `count` used in every function; `desc` used in `getTopUsers` + `getRecentConfigChanges`;
    `sql` used throughout.
- Module-level fragments kept byte-for-byte: `inThisMonth`, `inLastMonth`,
  `isConfigChange`; helpers `num()` and `rate()` kept.
- Aggregation semantics preserved (decomposition, not rewrite):
  - KPI: single grouped FILTER query; `totalActivity = {value: totalAll, delta: totalThis - totalLast}`,
    `configChanges = {value: cfgAll, delta: cfgThis - cfgLast}`,
    `successRate = {value: rate(successAll,totalAll), delta: rate(successThis,totalThis) - rate(successLast,totalLast)}`
    (success delta in percentage points).
  - Series: daily `date_trunc('day')` over `now() - interval '13 days'`, format `'YYYY-MM-DD'`;
    weekly `date_trunc('week')` over `now() - interval '11 weeks'`, format `'IYYY-"W"IW'`;
    monthly `date_trunc('month')` over `now() - interval '11 months'`, format `'YYYY-MM'`.
    Run together with `Promise.all`, returned as `{ daily, weekly, monthly }`.
  - Config by operation: `module,action,count()` where `isConfigChange`, zero-filled into
    the fixed order `['ROUTE/ADD','ROUTE/DELETE','ACL/ADD','ACL/DELETE']` via a Map;
    returned as `{ items }`, field name `operation` kept.
  - Top users: group by `username`, `orderBy(desc(sql\`count(*)\`))`, `limit(8)`,
    `username ?? '—'`; returned as `{ items }`.
  - Recent config changes: safe projection `{ id, module, action, username, status, createdAt }`
    where `isConfigChange`, `orderBy(desc(createdAt))`, `limit(8)`, `createdAt.toISOString()`;
    returned as `{ items }`. No JSONB payloads/secrets.

### Handlers (five new files)
- Each is thin: `defineEventHandler(async (event) => { await requireAuthenticatedUser(event);
  return ok(await <serviceFn>(useDatabase())) })`.
- Imports match the summary handler's relative paths: service `../../services/dashboard.service`,
  `requireAuthenticatedUser` from `../../utils/auth`, `useDatabase` from `../../utils/db`,
  `ok` from `../../utils/envelope`, `defineEventHandler` from `h3`.
- Auth-only: `requireAuthenticatedUser` only, NO `requirePermission` (matches `audit/index.get.ts`).
- Route paths from filenames: `/api/dashboard/kpi`, `/api/dashboard/activity-series`,
  `/api/dashboard/config-by-operation`, `/api/dashboard/top-users`,
  `/api/dashboard/recent-config-changes`.

### Client (`useApi.ts`)
- `dashboard` now exposes exactly five methods: `kpi()`, `activitySeries()`,
  `configByOperation()`, `topUsers()`, `recentConfigChanges()`, each a one-liner over
  `apiGet<T>` with the matching URL and return type.
- Old `DashboardSummary` interface and `summary()` method removed; grep for
  `summary`/`DashboardSummary` across the three edited source files returns no matches.
- No other section (auth, aclOps, routeOps, deviceCredentials, audit, aclLogs, routeLogs,
  users, roles) changed; `apiGet`/`apiSend` helpers untouched.

### Page (`app/pages/index.vue`)
- Five independent widget states, each with its own `*Data` ref + `*Pending` + `*Error` +
  `loadX()` (sets pending=true/error=false, try assign, catch error=true, finally pending=false).
- `onMounted` calls all five `loadX()` without `await` between them → they run concurrently;
  no sequential await chain and no combined `summary` ref.
- Each widget block renders its OWN `LoadingState` while pending, `ErrorState` with
  `@retry="loadX"` (re-fetches only that widget) on error, and `EmptyState` when empty
  (where applicable). No single page-level wrapper hides the others.
- Activity toggle: `granularity` ref + `activeSeries` computed source from
  `seriesData.value?.daily|weekly|monthly` — client-side only, triggers NO network call on toggle.
- Chart keeps sparse-data handling: `barHeight` gives non-zero counts a min 2% height so the
  two real days stay visible; renders only existing buckets (no synthesized/faked days).
- Visuals preserved: KPI row no icons + deltas (`deltaCount`, success-rate ▲/▼ + `pp`);
  Config bars with `op.operation.replace('/', ' / ')` + `configBarWidth`; Top Users rank
  `#index+1` + name + count; Recent feed with inline `text-ok`/`text-bad` Success/Failed
  (no StatusBadge); `formatTime` kept.
- Tokens only (`bg-surface`, `bg-panel`, `border-line`/`ring-line`, `text-ink`, `text-muted`,
  `bg-brand`, `text-ok`, `text-bad`); no hex; English copy; no new charting dependency
  (plain div bars). `PageHeader`, `LoadingState`, `ErrorState`, `EmptyState` are the same
  auto-imported components (props confirmed: LoadingState `message`, ErrorState `message` +
  `@retry`, EmptyState `title`/`description`/`icon`).

### Cross-check
- Five service fns ↔ five handlers ↔ five `useApi` methods ↔ five `index.vue` loaders all
  agree on route path and response shape.
- `grep summary|DashboardSummary` over the service, `server/api/dashboard/`, `useApi.ts`, and
  `index.vue` returns no matches. `summary.get.ts` no longer exists.
- Scope limited to the four dashboard files + the five new handlers + the deletion. No schema,
  migration, or dependency change.
