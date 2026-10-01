# Implementation Plan — BI Dashboard (real data from audit_logs)

Scope: dashboard only. Files touched:
- `server/services/dashboard.service.ts` (extend/replace aggregation + response interface)
- `app/composables/useApi.ts` (update `DashboardSummary` interface + `dashboard.summary()` return type)
- `app/pages/index.vue` (rebuild the page with the 5 approved widgets)
- `server/api/dashboard/summary.get.ts` — only if a signature change is needed (it is NOT; it just calls `summary(useDatabase())` and wraps with `ok()`). Leave it unchanged.

NO new DB tables, NO migration, NO new dependency, NO charting library. All numbers computed by SQL aggregation over `audit_logs`; nothing hardcoded.

## Decisions (grounded in the files read)

- **Response shape = plain TS interface, duplicated in two places (keep existing convention).** The current `DashboardSummary` is a plain `export interface` in `server/services/dashboard.service.ts` AND re-declared locally in both `app/composables/useApi.ts` and `app/pages/index.vue`. There is NO Zod schema for the dashboard (confirmed: `shared/schemas/` has no dashboard schema; `audit.schema.ts` etc. exist but nothing for dashboard). Per AGENTS.md "if the current summary is a plain TS interface, extend that interface" — so we extend the interface and keep the client-side duplicate in `useApi.ts` in sync. Do NOT introduce a Zod schema.
- **Keep Drizzle queries directly in `dashboard.service.ts` (no new repository).** The current service imports `count, desc, eq, sql from 'drizzle-orm'` and `auditLogs from '~~/database/schema/audit-logs'` and queries `db` directly inside `summary()`. AGENTS.md says to keep this existing local pattern rather than add a repository just for the dashboard. Match that style exactly.
- **This is a REPLACEMENT, not an addition.** The old fields (`totalExecutions`, `successCount`, `failedCount`, `perModule`, `recentActivities`, `failedRecent`) are only consumed by `index.vue`, which we rebuild. So we replace the `DashboardSummary` interface and the `summary()` return object wholesale with the new shape. Remove the now-unused `toAuditResponse` import and `eq` import if they become unused after the rewrite (check: `recentActivities`/`failedRecent` are dropped, so `toAuditResponse` and the `recent`/`failed` queries go away).
- **Date math uses the DB (`now()` / `date_trunc`) for server-consistent boundaries.** `created_at` is `timestamptz`. Use `date_trunc('month', now())` for the current-month start and `date_trunc('month', now()) - interval '1 month'` for the previous-month start, all evaluated in the DB so there is no Node/DB timezone drift. Same approach for day/week/month buckets.
- **KPI deltas are STATIC "vs last month"; the Activity Over Time chart has its OWN Daily/Weekly/Monthly toggle.** They are independent — the KPI never follows the chart toggle.
- **Server returns all three series** (`dailySeries`, `weeklySeries`, `monthlySeries`) so the chart toggle is instant client-side with no refetch.

## New response interface (source of truth)

Define in `server/services/dashboard.service.ts` and mirror verbatim in `app/composables/useApi.ts` (and import/retype in `index.vue`):

```ts
interface KpiDelta {
  value: number          // big number for the card
  delta: number          // change: thisMonth - lastMonth (count) or pp change (success rate)
}

interface SeriesPoint {
  bucket: string         // ISO-ish bucket key from the DB (e.g. '2026-10-01')
  count: number
}

interface ConfigByOperation {
  operation: string      // 'ROUTE/ADD' | 'ROUTE/DELETE' | 'ACL/ADD' | 'ACL/DELETE'
  count: number
}

interface TopUser {
  username: string       // '—' when null
  count: number
}

interface RecentConfigChange {
  id: string
  module: string         // 'ACL' | 'ROUTE'
  action: string         // 'ADD' | 'DELETE'
  username: string | null
  status: string         // 'SUCCESS' | 'FAILED'
  createdAt: string      // ISO string
}

export interface DashboardSummary {
  totalActivity: KpiDelta       // all-time count + (thisMonth - lastMonth)
  configChanges: KpiDelta       // all-time config-change count + delta
  successRate: KpiDelta         // all-time SUCCESS/total*100 (rounded) + pp delta
  dailySeries: SeriesPoint[]    // last ~14 days
  weeklySeries: SeriesPoint[]   // last ~12 ISO weeks
  monthlySeries: SeriesPoint[]  // last ~12 months
  configByOperation: ConfigByOperation[] // exactly 4 entries, zero-filled
  topUsers: TopUser[]           // grouped by username, count desc, limit 8
  recentConfigChanges: RecentConfigChange[] // newest first, limit 8
}
```

Config-change predicate everywhere: `module IN ('ACL','ROUTE') AND action IN ('ADD','DELETE')`.

---

- [ ] 1. Rewrite the aggregation in `server/services/dashboard.service.ts`.
      Replace the `DashboardSummary` interface and the body of `summary(db)` with the new shape above. Keep the existing direct-Drizzle style (`db.select({...}).from(auditLogs).groupBy(...)`, `count()`, `sql`, `desc`). Compute each piece with the queries below; run them with `await Promise.all([...])` where independent. Drop the old `recentActivities`/`failedRecent` queries and the `toAuditResponse` import if unused (keep imports that are still referenced).
      Files: `server/services/dashboard.service.ts`
      Verify: `npm run typecheck` passes (user runs it); the file compiles with no unused-import errors under TS strict.

      Query details (all over `auditLogs`):

      **(a) KPI totals + month windows.** Use raw `sql` month boundaries so counts are server-consistent. One compact approach — a single grouped query bucketing each row into all-time / this-month / last-month with `FILTER`:
      ```ts
      const kpi = await db.select({
        totalAll: count(),
        totalThis: sql<number>`count(*) filter (where ${auditLogs.createdAt} >= date_trunc('month', now()))`,
        totalLast: sql<number>`count(*) filter (where ${auditLogs.createdAt} >= date_trunc('month', now()) - interval '1 month' and ${auditLogs.createdAt} < date_trunc('month', now()))`,
        successAll: sql<number>`count(*) filter (where ${auditLogs.status} = 'SUCCESS')`,
        successThis: sql<number>`count(*) filter (where ${auditLogs.status} = 'SUCCESS' and ${auditLogs.createdAt} >= date_trunc('month', now()))`,
        successLast: sql<number>`count(*) filter (where ${auditLogs.status} = 'SUCCESS' and ${auditLogs.createdAt} >= date_trunc('month', now()) - interval '1 month' and ${auditLogs.createdAt} < date_trunc('month', now()))`,
        cfgAll: sql<number>`count(*) filter (where ${auditLogs.module} in ('ACL','ROUTE') and ${auditLogs.action} in ('ADD','DELETE'))`,
        cfgThis: sql<number>`count(*) filter (where ${auditLogs.module} in ('ACL','ROUTE') and ${auditLogs.action} in ('ADD','DELETE') and ${auditLogs.createdAt} >= date_trunc('month', now()))`,
        cfgLast: sql<number>`count(*) filter (where ${auditLogs.module} in ('ACL','ROUTE') and ${auditLogs.action} in ('ADD','DELETE') and ${auditLogs.createdAt} >= date_trunc('month', now()) - interval '1 month' and ${auditLogs.createdAt} < date_trunc('month', now()))`,
      }).from(auditLogs)
      ```
      Note: `count()` and `sql<number>` from postgres.js may come back as strings — coerce with `Number(...)` before arithmetic (the existing code assigns `r.value` straight from `count()`, but once we do math we must `Number()` to be safe).
      - `totalActivity = { value: Number(totalAll), delta: Number(totalThis) - Number(totalLast) }`
      - `configChanges = { value: Number(cfgAll), delta: Number(cfgThis) - Number(cfgLast) }`
      - Success rate: `rate(all) = totalAll ? round(successAll/totalAll*100) : 0`; `rateThis` and `rateLast` computed the same from their windowed counts; `successRate = { value: rate(all), delta: rateThis - rateLast }` (percentage-point change, may be 0 when a window is empty — guard divide-by-zero).

      **(b) Three time series via `date_trunc`.** Each is its own grouped query returning ordered buckets; format the bucket to a stable string in SQL with `to_char` so the client gets a plain string:
      ```ts
      // daily: last 14 days
      const daily = await db.select({
        bucket: sql<string>`to_char(date_trunc('day', ${auditLogs.createdAt}), 'YYYY-MM-DD')`,
        count: count(),
      }).from(auditLogs)
        .where(sql`${auditLogs.createdAt} >= date_trunc('day', now()) - interval '13 days'`)
        .groupBy(sql`date_trunc('day', ${auditLogs.createdAt})`)
        .orderBy(sql`date_trunc('day', ${auditLogs.createdAt})`)
      ```
      Weekly: `date_trunc('week', ...)`, window `- interval '11 weeks'`, bucket `to_char(..., 'IYYY-"W"IW')` (ISO week, e.g. `2026-W40`). Monthly: `date_trunc('month', ...)`, window `- interval '11 months'`, bucket `to_char(..., 'YYYY-MM')`. Map rows to `{ bucket, count: Number(count) }`. Sparse/empty is fine — the client renders only what is returned (and shows EmptyState if a series is empty).

      **(c) configByOperation — exactly 4 counts, zero-filled.** Group the config-change rows by module+action, then build the four fixed entries so missing combos still render as 0:
      ```ts
      const cfgRows = await db.select({
        module: auditLogs.module, action: auditLogs.action, count: count(),
      }).from(auditLogs)
        .where(sql`${auditLogs.module} in ('ACL','ROUTE') and ${auditLogs.action} in ('ADD','DELETE')`)
        .groupBy(auditLogs.module, auditLogs.action)
      ```
      Then map into the fixed order `['ROUTE/ADD','ROUTE/DELETE','ACL/ADD','ACL/DELETE']`, looking up each `MODULE/ACTION` count (default 0).

      **(d) topUsers — grouped by username, count desc, limit 8.**
      ```ts
      const users = await db.select({ username: auditLogs.username, count: count() })
        .from(auditLogs)
        .groupBy(auditLogs.username)
        .orderBy(desc(count()))
        .limit(8)
      ```
      Map to `{ username: r.username ?? '—', count: Number(r.count) }`.

      **(e) recentConfigChanges — safe shape, newest first, limit 8.** Select ONLY the safe columns (never raw rows / no payloads):
      ```ts
      const recent = await db.select({
        id: auditLogs.id, module: auditLogs.module, action: auditLogs.action,
        username: auditLogs.username, status: auditLogs.status, createdAt: auditLogs.createdAt,
      }).from(auditLogs)
        .where(sql`${auditLogs.module} in ('ACL','ROUTE') and ${auditLogs.action} in ('ADD','DELETE')`)
        .orderBy(desc(auditLogs.createdAt))
        .limit(8)
      ```
      Map `createdAt` to ISO string: `{ ...r, createdAt: r.createdAt.toISOString() }`. This excludes all JSONB payloads and secrets by construction (AGENTS.md: never return raw rows).

- [ ] 2. Leave `server/api/dashboard/summary.get.ts` unchanged.
      The handler already does `await requireAuthenticatedUser(event); return ok(await summary(useDatabase()))`. No feature permission (dashboard is common access). No signature change needed since `summary(db)` keeps the same `(db: Database)` signature.
      Files: none (confirm only)
      Verify: `npm run typecheck` passes; the handler still imports `summary` correctly.

- [ ] 3. Update the client type in `app/composables/useApi.ts` to match the new `DashboardSummary`.
      Replace the local `interface DashboardSummary { ... }` (currently `totalExecutions`/`successCount`/`failedCount`/`perModule`/`recentActivities`/`failedRecent`) with the new interface shape from this plan (including the `KpiDelta`/`SeriesPoint`/`ConfigByOperation`/`TopUser`/`RecentConfigChange` helper interfaces, declared above the `DashboardSummary` interface in this file). Keep `dashboard.summary(): Promise<DashboardSummary>` using the existing `apiGet<DashboardSummary>('/api/dashboard/summary')` envelope-unwrap pattern — do not change `apiGet`. Remove the now-unused `AuditResponse` import ONLY IF nothing else in the file still uses it (it is used elsewhere in `audit`/`aclLogs`/`routeLogs` return types, so KEEP the import).
      Files: `app/composables/useApi.ts`
      Verify: `npm run typecheck` passes; `useApi().dashboard.summary()` resolves to the new type.

- [ ] 4. Rebuild `app/pages/index.vue` with the five approved widgets.
      Keep the existing `load()` / `pending` / `error` pattern, `onMounted(load)`, `PageHeader title="Dashboard"`, and `LoadingState` / `ErrorState` / `EmptyState` usage. Retype the local `DashboardSummary` interface to match the new shape (or import the helper types — simplest is to re-declare the interface locally as the page does today). All copy and comments in English. Use ONLY token-backed utility classes (`bg-surface`, `bg-panel`, `border-line`/`ring-line`, `text-ink`, `text-muted`, `bg-brand`/`text-brand`, `text-ok`, `text-bad`); never hard-code hex. Icon-only buttons (none expected here, but the toggle is text buttons) — any icon-only control gets `aria-label`.
      Files: `app/pages/index.vue`
      Verify: `npm run dev` renders the dashboard with real data (user runs it); `npm run typecheck` and `npm run lint` pass. Each widget shows data for the ~93-row dev dataset; empty series fall back to EmptyState without errors.

      Widget structure (token classes to use):

      **Layout wrapper:** `<div class="flex flex-col gap-6">` with `PageHeader`, then `LoadingState` (v-if pending), `ErrorState` (v-else-if error, `@retry="load"`), then `<template v-else-if="summary">` wrapping the widgets.

      **(1) KPI row** — `<div class="grid grid-cols-1 gap-4 sm:grid-cols-3">`, three cards `rounded-lg border border-line bg-panel p-5`, NO icons. Each card:
      - label: `<p class="text-xs text-muted">` (e.g. "Total Activity", "Config Changes", "Success Rate")
      - number: `<p class="mt-1 text-[28px] font-semibold leading-none text-ink">` — Success Rate shows `{{ value }}%`.
      - delta line: `<p class="mt-1 text-[11px]">`. For Total Activity & Config Changes use a NEUTRAL tone (`text-muted` or `text-brand`), format `+N` / `−N` / `0` "vs last month". For Success Rate, higher-is-better: `text-ok` when `delta >= 0` (show `▲`), `text-bad` when `delta < 0` (show `▼`), suffix "pp vs last month". A small `deltaLabel(n)` helper formats sign.

      KPI cards explained (put as a short comment block in the script):
      - **Total Activity** — all-time count of every audit row; delta = this calendar month vs previous. Overall engagement/volume signal.
      - **Config Changes** — all-time count of actual device-policy mutations (ACL/ROUTE ADD/DELETE); delta vs last month. The "real work" signal, separate from read-only SHOW/LOGIN noise.
      - **Success Rate** — SUCCESS/total × 100 all-time; delta in percentage points vs last month. Operational health; green up / red down.

      **(2) Activity Over Time** — card `rounded-lg border border-line bg-panel`, header row with title "Activity Over Time" (`text-[17px] font-semibold text-ink`) on the left and a segmented Daily/Weekly/Monthly toggle on the right. Toggle = three text buttons styled like the Log Trail selects, token-based: active button `bg-brand text-white`, inactive `bg-surface text-muted ring-1 ring-line`, grouped in a `inline-flex rounded-md overflow-hidden`. A `ref` `granularity: 'daily'|'weekly'|'monthly'` switches a computed `activeSeries` between `summary.dailySeries|weeklySeries|monthlySeries` — NO refetch. Render bars as plain token-styled divs: a flex row of columns, each column height = `count / maxCount * 100%` using `bg-brand` on a `bg-surface` track; x-axis label under each bar (`text-[11px] text-muted`), formatted readable (daily `Oct 1`, weekly `W40`, monthly `Oct 2026`) via small client formatters off the `bucket` string. If `activeSeries.length === 0` show `EmptyState`. No charting library.

      **(3) Config Changes by Operation** — card; title "Config Changes by Operation". For each of the 4 `configByOperation` entries render a horizontal bar: label (`text-sm text-ink`, e.g. `ROUTE / ADD`) + count (`text-muted`) + a track `h-2 rounded bg-surface` containing a fill `bg-brand` whose width = `count / maxOfFour * 100%` (guard max 0 → width 0). Fixed order ROUTE/ADD, ROUTE/DELETE, ACL/ADD, ACL/DELETE. Zeros render as empty tracks (no EmptyState needed since 4 fixed rows always present).

      **(4) Top Active Users** — card; title "Top Active Users". Ranked list (`divide-y divide-line`), each row: rank (`text-muted` `#1`…), username (`text-ink font-medium`, `—` fallback already server-side), count (`text-muted`, right-aligned). NO role, NO failed column. `EmptyState` if list empty.

      **(5) Recent Config Changes** — card; title "Recent Config Changes". List of `recentConfigChanges`, each row: `MODULE / ACTION` (`text-sm font-medium text-ink`), sub-line engineer + timestamp (`text-xs text-muted`, timestamp via `new Date(createdAt).toLocaleString('en-GB')` matching Log Trail's `formatTime`), and an INLINE status label on the right — render inline (NOT the shared StatusBadge): `<span class="shrink-0 text-xs font-semibold" :class="status === 'SUCCESS' ? 'text-ok' : 'text-bad'">{{ status === 'SUCCESS' ? 'Success' : 'Failed' }}</span>`. Use `EmptyState` (icon `i-lucide-history`) when empty.

- [ ] 5. Full verification pass.
      Confirm the backend returns the new envelope and the page renders all five widgets against the live dev DB (~93 rows: config-change ops ROUTE/ADD 3, ROUTE/DELETE 1(FAILED), ACL/ADD 2, ACL/DELETE 4; AUTH/USER present; data spans 2026-09-25..2026-10-01, so weekly/monthly series will be short — must render without error).
      Files: none (verification)
      Verify (user runs): `npm run typecheck`, `npm run lint`, and `npm run dev` → open the dashboard; KPI numbers, chart toggle (Daily/Weekly/Monthly switch instantly), config bars, top users, and recent config changes all populate from real data with no console errors. Clean up any temp files.

## Notes / assumptions
- `count()`/`sql<number>` from the postgres.js driver can return strings; wrap in `Number()` before any arithmetic (deltas, rate). The existing code never did math on them, so this is the one new care-point.
- Weekly/monthly windows will be sparse given the dev data only spans one week — this is expected; the UI must handle short/empty series gracefully (EmptyState for an empty active series; bars just render the few buckets present).
- No `.env` reads, no secrets, no raw rows returned — `recentConfigChanges` selects an explicit safe column list.
- `summary.get.ts` and the envelope (`ok()`), auth (`requireAuthenticatedUser`), and `useDatabase()` are unchanged.
